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

Abre `http://127.0.0.1:21213` en el navegador del teléfono. El login empieza desactivado; desde la sección **Acceso al panel** puedes activarlo y cambiar la contraseña. La configuración se guarda en `config.json` y se conserva al reiniciar. La contraseña inicial es `123456789`.

Al iniciar, el servidor libera automáticamente el puerto configurado terminando el proceso que lo esté ocupando. En Termux detecta el proceso con `lsof` o, como respaldo, mediante `/proc`.

Antes de exponer el servidor mediante un túnel o una red pública, activa el login y establece una contraseña propia y segura. No publiques ni compartas `config.json` ni `.env`; ambos se mantienen fuera del repositorio.
