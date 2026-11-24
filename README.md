# Carrera de tortugas

Servidor Node.js y overlay para TikTok Live.

## Ejecutar en Termux (Android)

Instala Git y Node.js, clona el repositorio e instala las dependencias:

```sh
pkg update
pkg install git nodejs
git clone https://github.com/jsantdev/pais-tortugas.git
cd pais-tortugas
npm install
```

Inicia el servidor indicando el usuario de TikTok:

```sh
TIKTOK_USERNAME=tu_usuario HOST=127.0.0.1 PORT=21213 npm start
```

Abre `http://127.0.0.1:21213` en el navegador del teléfono. Si el panel solicita una contraseña, usa la que el servidor muestra al iniciarse en Termux. Para detenerlo, pulsa `Ctrl+C`.

No publiques ni compartas tu archivo `.env`; se mantiene fuera del repositorio.
