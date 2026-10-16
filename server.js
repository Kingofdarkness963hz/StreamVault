const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ytdlp = require('yt-dlp-exec');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const downloadDir = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error al conectar con SQLite:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        inicializarTablas();
    }
});

function inicializarTablas() {
    db.serialize(() => {
        // Tabla de archivos individuales
        db.run(`CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            categoria TEXT,
            ruta_archivo TEXT,
            url TEXT,
            tipo TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run(`ALTER TABLE items ADD COLUMN url TEXT`, (err) => {});
            db.run(`ALTER TABLE items ADD COLUMN tipo TEXT`, (err) => {});
            db.run(`ALTER TABLE items ADD COLUMN fecha DATETIME DEFAULT CURRENT_TIMESTAMP`, (err) => {});
        });

        // Tabla padre para Playlists / Colecciones
        db.run(`CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT NOT NULL,
            url TEXT NOT NULL,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Tabla relacional para los elementos dentro de una Playlist
        db.run(`CREATE TABLE IF NOT EXISTS playlist_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER,
            nombre TEXT NOT NULL,
            categoria TEXT,
            ruta_archivo TEXT,
            FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        )`);

        // Bitácora de Auditoría
        db.run(`CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            accion TEXT NOT NULL,
            detalle TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        console.log('Estructura de base de datos verificada.');
    });
}

// Rutas de consulta individuales
app.get('/items', (req, res) => {
    db.all(`SELECT * FROM items ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'success', data: rows });
    });
});

// Rutas para consultar Playlists y su desglose
app.get('/playlists', (req, res) => {
    db.all(`SELECT * FROM playlists ORDER BY id DESC`, [], (err, playlists) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'success', data: playlists });
    });
});

app.get('/playlists/:id/items', (req, res) => {
    const { id } = req.params;
    db.all(`SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY id DESC`, [id], (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'success', data: items });
    });
});

function extraerNombreDeUrlDirecta(url) {
    try {
        const parsed = new URL(url);
        const basename = path.basename(parsed.pathname, path.extname(parsed.pathname));
        if (basename && basename.length > 0) {
            return decodeURIComponent(basename).replace(/[<>:"/\\|?*]/g, '_');
        }
    } catch (e) {}
    return 'archivo_web';
}

// --- MOTOR YOUTUBE INDIVIDUAL ---
app.post('/download/youtube', async (req, res) => {
    const { url, formato, force } = req.body;
    if (!url) return res.status(400).json({ error: 'El campo "url" is obligatorio' });

    const esAudio = ['mp3', 'm4a', 'wav'].includes(formato);
    const tipoMedio = esAudio ? 'audio' : 'video';

    try {
        if (!force) {
            db.get(`SELECT * FROM items WHERE url = ? AND tipo = ? ORDER BY id DESC LIMIT 1`, [url, tipoMedio], async (err, existingRow) => {
                if (err) return res.status(500).json({ error: err.message });
                if (existingRow) {
                    return res.status(200).json({ duplicate: true, nombreExistente: existingRow.nombre });
                }
                await procesarDescargaYouTube(url, formato, tipoMedio, res, false);
            });
        } else {
            await procesarDescargaYouTube(url, formato, tipoMedio, res, true);
        }
    } catch (error) {
        console.error('❌ Error en Motor YouTube:', error);
        res.status(500).json({ error: error.message });
    }
});

async function procesarDescargaYouTube(url, formato, tipoMedio, res, esForzado) {
    const timestamp = Date.now();
    let ext = '.mp4';
    if (formato === 'mp3') ext = '.mp3';
    else if (formato === 'm4a') ext = '.m4a';
    else if (formato === 'wav') ext = '.wav';
    else if (formato === 'webm') ext = '.webm';

    let rawTitle = "video_descargado";
    try {
        const titleOutput = await ytdlp(url, { print: 'title', noCheckCertificates: true, noWarnings: true, noPlaylist: true });
        if (titleOutput) rawTitle = titleOutput.trim().replace(/[<>:"/\\|?*]/g, '_');
    } catch (e) {}

    let finalFileName = `${rawTitle}${ext}`;
    let finalFilePath = path.join(downloadDir, finalFileName);
    
    if (esForzado || fs.existsSync(finalFilePath)) {
        let counter = 1;
        while (fs.existsSync(path.join(downloadDir, `${rawTitle} (${counter})${ext}`))) {
            counter++;
        }
        finalFileName = `${rawTitle} (${counter})${ext}`;
        finalFilePath = path.join(downloadDir, finalFileName);
    }

    const fileRelativePath = `/downloads/${finalFileName}`;
    const etiquetaTipo = tipoMedio === 'video' ? 'Video' : 'Audio';
    const categoriaFinal = `YouTube - ${etiquetaTipo} (${formato.toUpperCase()})`;

    let ytdlpOptions = {
        output: path.join(downloadDir, `temp_${timestamp}.%(ext)s`),
        noCheckCertificates: true,
        noWarnings: true,
        noPlaylist: true,
        ffmpegLocation: path.dirname(ffmpegInstaller.path),
    };

    if (tipoMedio === 'audio') {
        ytdlpOptions.extractAudio = true;
        ytdlpOptions.audioFormat = formato === 'm4a' ? 'm4a' : (formato === 'wav' ? 'wav' : 'mp3');
        ytdlpOptions.audioQuality = '0';
    } else {
        ytdlpOptions.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
        ytdlpOptions.mergeOutputFormat = 'mp4';
    }

    await ytdlp(url, ytdlpOptions);
    
    const files = fs.readdirSync(downloadDir);
    const downloadedFile = files.find(f => f.startsWith(`temp_${timestamp}`));
    if (!downloadedFile) throw new Error("yt-dlp no generó archivo temporal.");

    const downloadedPath = path.join(downloadDir, downloadedFile);
    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
    fs.renameSync(downloadedPath, finalFilePath);

    const insertQuery = `INSERT INTO items (nombre, categoria, ruta_archivo, url, tipo) VALUES (?, ?, ?, ?, ?)`;
    db.run(insertQuery, [finalFileName, categoriaFinal, fileRelativePath, url, tipoMedio], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`INSERT INTO audit_log (accion, detalle) VALUES (?, ?)`, ['PROCESAR', `[YouTube] Éxito procesando: ${finalFileName}`]);
        res.status(201).json({ mensaje: 'Procesado con éxito', archivo: fileRelativePath });
    });
}

// --- MOTOR AISLADO: PLAYLISTS DE YOUTUBE ---
app.post('/download/playlist', async (req, res) => {
    const { url, formato } = req.body;
    if (!url) return res.status(400).json({ error: 'El campo "url" es obligatorio' });

    const esAudio = ['mp3', 'm4a', 'wav'].includes(formato);
    const tipoMedio = esAudio ? 'audio' : 'video';

    try {
        console.log(`[Playlist Engine] Extrayendo metadatos de la playlist: ${url}`);
        
        let playlistTitle = "Playlist de YouTube";
        try {
            const playlistInfo = await ytdlp(url, { dumpSingleJson: true, flatPlaylist: true, noCheckCertificates: true, noWarnings: true });
            if (playlistInfo && playlistInfo.title) {
                playlistTitle = playlistInfo.title.trim().replace(/[<>:"/\\|?*]/g, '_');
            }
        } catch (e) {
            console.warn("No se pudo obtener el título de la playlist, usando genérico.");
        }

        db.run(`INSERT INTO playlists (titulo, url) VALUES (?, ?)`, [playlistTitle, url], async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const playlistId = this.lastID;

            res.status(202).json({ mensaje: 'Playlist aceptada, procesando elementos en segundo plano', playlistId, playlistTitle });

            const timestampBatch = Date.now();
            let ext = tipoMedio === 'video' ? '.mp4' : '.mp3';
            if (formato === 'm4a') ext = '.m4a';
            else if (formato === 'wav') ext = '.wav';
            else if (formato === 'webm') ext = '.webm';

            let ytdlpOptions = {
                output: path.join(downloadDir, `pl_${timestampBatch}_%(title)s.%(ext)s`),
                noCheckCertificates: true,
                noWarnings: true,
                ffmpegLocation: path.dirname(ffmpegInstaller.path),
            };

            if (tipoMedio === 'audio') {
                ytdlpOptions.extractAudio = true;
                ytdlpOptions.audioFormat = formato === 'm4a' ? 'm4a' : (formato === 'wav' ? 'wav' : 'mp3');
                ytdlpOptions.audioQuality = '0';
            } else {
                ytdlpOptions.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
                ytdlpOptions.mergeOutputFormat = 'mp4';
            }

            console.log(`[Playlist Engine] Iniciando descarga masiva para playlist ID: ${playlistId}`);
            await ytdlp(url, ytdlpOptions);

            const files = fs.readdirSync(downloadDir);
            const downloadedFiles = files.filter(f => f.startsWith(`pl_${timestampBatch}_`));

            const etiquetaTipo = tipoMedio === 'video' ? 'Video' : 'Audio';
            const categoriaFinal = `Playlist - ${etiquetaTipo} (${formato.toUpperCase()})`;

            for (const file of downloadedFiles) {
                const cleanName = file.replace(`pl_${timestampBatch}_`, '');
                const oldPath = path.join(downloadDir, file);
                const newPath = path.join(downloadDir, cleanName);

                let finalCleanName = cleanName;
                let finalNewPath = newPath;
                if (fs.existsSync(newPath)) {
                    let extName = path.extname(cleanName);
                    let baseNameOnly = path.basename(cleanName, extName);
                    let counter = 1;
                    while (fs.existsSync(path.join(downloadDir, `${baseNameOnly} (${counter})${extName}`))) {
                        counter++;
                    }
                    finalCleanName = `${baseNameOnly} (${counter})${extName}`;
                    finalNewPath = path.join(downloadDir, finalCleanName);
                }

                if (oldPath !== finalNewPath) {
                    fs.renameSync(oldPath, finalNewPath);
                }

                const fileRelativePath = `/downloads/${finalCleanName}`;

                db.run(
                    `INSERT INTO playlist_items (playlist_id, nombre, categoria, ruta_archivo) VALUES (?, ?, ?, ?)`,
                    [playlistId, finalCleanName, categoriaFinal, fileRelativePath]
                );
            }

            db.run(`INSERT INTO audit_log (accion, detalle) VALUES (?, ?)`, 
                ['PROCESAR', `[Playlist] Éxito procesando colección: ${playlistTitle} (${downloadedFiles.length} elementos)`]
            );
            console.log(`[Playlist Engine] Playlist "${playlistTitle}" procesada con éxito (${downloadedFiles.length} archivos).`);
        });

    } catch (error) {
        console.error('❌ Error en Motor Playlist:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// --- MOTOR ENLACES DIRECTOS ---
app.post('/download/direct', async (req, res) => {
    const { url, formato, force } = req.body;
    if (!url) return res.status(400).json({ error: 'El campo "url" es obligatorio' });

    const esAudio = ['mp3', 'm4a', 'wav'].includes(formato);
    const tipoMedio = esAudio ? 'audio' : 'video';

    try {
        if (!force) {
            db.get(`SELECT * FROM items WHERE url = ? AND tipo = ? ORDER BY id DESC LIMIT 1`, [url, tipoMedio], async (err, existingRow) => {
                if (err) return res.status(500).json({ error: err.message });
                if (existingRow) {
                    return res.status(200).json({ duplicate: true, nombreExistente: existingRow.nombre });
                }
                await procesarDescargaDirecta(url, formato, tipoMedio, res, false);
            });
        } else {
            await procesarDescargaDirecta(url, formato, tipoMedio, res, true);
        }
    } catch (error) {
        console.error('❌ Error en Motor Directo:', error);
        res.status(500).json({ error: error.message });
    }
});

async function procesarDescargaDirecta(url, formato, tipoMedio, res, esForzado) {
    const timestamp = Date.now();
    const tempInputPath = path.join(downloadDir, `temp_${timestamp}.mp4`);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            }
        });

        if (!response.ok) throw new Error(`Fallo HTTP: ${response.status} ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(tempInputPath, Buffer.from(arrayBuffer));

        let ext = '.mp4';
        if (formato === 'mp3') ext = '.mp3';
        else if (formato === 'm4a') ext = '.m4a';
        else if (formato === 'wav') ext = '.wav';
        else if (formato === 'webm') ext = '.webm';

        let rawTitle = extraerNombreDeUrlDirecta(url);
        let finalFileName = `${rawTitle}${ext}`;
        let finalFilePath = path.join(downloadDir, finalFileName);

        if (esForzado || fs.existsSync(finalFilePath)) {
            let counter = 1;
            while (fs.existsSync(path.join(downloadDir, `${rawTitle} (${counter})${ext}`))) {
                counter++;
            }
            finalFileName = `${rawTitle} (${counter})${ext}`;
            finalFilePath = path.join(downloadDir, finalFileName);
        }

        const fileRelativePath = `/downloads/${finalFileName}`;
        const etiquetaTipo = tipoMedio === 'video' ? 'Video' : 'Audio';
        const categoriaFinal = `Directo - ${etiquetaTipo} (${formato.toUpperCase()})`;

        if (formato && formato !== 'mp4') {
            await new Promise((resolve, reject) => {
                let command = ffmpeg(tempInputPath);
                if (formato === 'mp3') command.noVideo().audioCodec('libmp3lame').format('mp3');
                else if (formato === 'm4a') command.noVideo().audioCodec('aac').format('ipod');
                else if (formato === 'wav') command.noVideo().audioCodec('pcm_s16le').format('wav');
                else if (formato === 'webm') command.format('webm');
                
                command.on('end', resolve).on('error', reject).save(finalFilePath);
            });
            if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
        } else {
            fs.renameSync(tempInputPath, finalFilePath);
        }

        const insertQuery = `INSERT INTO items (nombre, categoria, ruta_archivo, url, tipo) VALUES (?, ?, ?, ?, ?)`;
        db.run(insertQuery, [finalFileName, categoriaFinal, fileRelativePath, url, tipoMedio], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run(`INSERT INTO audit_log (accion, detalle) VALUES (?, ?)`, ['PROCESAR', `[Directo] Éxito procesando: ${finalFileName}`]);
            res.status(201).json({ mensaje: 'Procesado con éxito', archivo: fileRelativePath });
        });

    } catch (error) {
        console.error('❌ Error en Motor Directo:', error);
        if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
        res.status(500).json({ error: error.message });
    }
}

// Ruta para eliminar archivos individuales
app.delete('/items/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM items WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Elemento no encontrado' });

        if (row.ruta_archivo) {
            const absolutePath = path.join(__dirname, 'public', row.ruta_archivo);
            if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
        }

        db.run(`DELETE FROM items WHERE id = ?`, [id], function(delErr) {
            if (delErr) return res.status(500).json({ error: delErr.message });
            db.run(`INSERT INTO audit_log (accion, detalle) VALUES (?, ?)`, ['ELIMINAR', `Se eliminó ID ${id}`]);
            res.json({ mensaje: `Registro ${id} eliminado` });
        });
    });
});

// Ruta para eliminar Playlists completas y sus archivos físicos asociados
app.delete('/playlists/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM playlists WHERE id = ?`, [id], (err, playlist) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });

        db.all(`SELECT * FROM playlist_items WHERE playlist_id = ?`, [id], (err, items) => {
            if (err) return res.status(500).json({ error: err.message });

            let eliminadosCount = 0;
            items.forEach(item => {
                if (item.ruta_archivo) {
                    const absolutePath = path.join(__dirname, 'public', item.ruta_archivo);
                    if (fs.existsSync(absolutePath)) {
                        try {
                            fs.unlinkSync(absolutePath);
                            eliminadosCount++;
                        } catch (e) {}
                    }
                }
            });

            db.run(`DELETE FROM playlist_items WHERE playlist_id = ?`, [id], (delItemsErr) => {
                if (delItemsErr) return res.status(500).json({ error: delItemsErr.message });

                db.run(`DELETE FROM playlists WHERE id = ?`, [id], function(delPlErr) {
                    if (delPlErr) return res.status(500).json({ error: delPlErr.message });

                    db.run(`INSERT INTO audit_log (accion, detalle) VALUES (?, ?)`, 
                        ['ELIMINAR', `Se eliminó la playlist "${playlist.titulo}" y ${eliminadosCount} archivos asociados`]
                    );

                    res.json({ mensaje: `Playlist ${id} eliminada` });
                });
            });
        });
    });
});

app.get('/audit', (req, res) => {
    db.all(`SELECT * FROM audit_log ORDER BY fecha DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'success', bitacora: rows });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor de Expansión Pro corriendo en http://localhost:${PORT}`);
});