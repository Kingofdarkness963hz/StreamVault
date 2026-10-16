# 🎬 StreamVault - Sistema Multi-Motor de Descarga y Gestión Multimedia

StreamVault es un panel de control multimedia accesible en red local (LAN) diseñado para la descarga, conversión, clasificación y persistencia de archivos de audio/video y listas de reproducción masivas.

## 🚀 Características Principales
- **Arquitectura Multi-Motor:** Procesamiento asíncrono para URLs directas (mp4/m4a) y motor especializado con `yt-dlp` para YouTube.
- **Soporte Masivo de Playlists:** Procesamiento por lotes en segundo plano con respuestas HTTP `202 Accepted`.
- **Conversión de Formatos:** Integración con `FFmpeg` para extraer y convertir medios (MP4, WebM, MP3, M4A, WAV).
- **Control de Duplicados & Borrado en Cascada:** Detección inteligente de enlaces procesados y eliminación sincrónica en sistema de archivos y base de datos relacional.
- **Monitoreo Automático (Smart Polling):** Sondeo dinámico desde el frontend con auto-apagado al finalizar tareas para optimizar el consumo de recursos.
- **Acceso Multidispositivo:** Configuración de servidor dinámico accesible desde cualquier dispositivo dentro de la misma red local (LAN).

## 🛠️ Stack Tecnológico
- **Backend:** Node.js, Express.js
- **Base de Datos:** SQLite (con claves foráneas y `ON DELETE CASCADE`)
- **Procesamiento de Archivos:** FFmpeg, yt-dlp
- **Frontend:** HTML5, JavaScript Vanilla (Fetch API, DOM), Tailwind CSS