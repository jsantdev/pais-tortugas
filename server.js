const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

let WebcastPushConnection;

function loadAdminPasswordFromEnvFile() {
  const envFile = path.join(__dirname, '.env');
  let contents;
  try {
    contents = fs.readFileSync(envFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(TIKTOK_USERNAME)\s*=\s*(.*?)\s*$/);
    if (!match || !match[1]) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value && !process.env[key]) process.env[key] = value;
  }
}

loadAdminPasswordFromEnvFile();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 21213);
const AUTH_CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_ADMIN_PASSWORD = '123456789';
const DEFAULT_USERNAME = cleanUsername(process.env.TIKTOK_USERNAME || 'mt_informaticapy');
const OVERLAY_FILE = path.join(__dirname, 'carrera-tortugas-overlay (3).html');
const COMMENTS_FILE = path.join(__dirname, 'comentarios.txt');
const COUNTRY_INTERACTIONS_FILE = path.join(__dirname, 'interacciones-paises.txt');
const COMMENTS_HEADER = 'Fecha UTC\tUsuario\tID TikTok\tComentario\n';
const COUNTRY_INTERACTIONS_HEADER = 'Fecha UTC\tPais ID\tPais\tEventos\n';
const AUTH_COOKIE = 'turtle_admin';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

function saveAuthSettings(settings) {
  const temporaryFile = `${AUTH_CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, AUTH_CONFIG_FILE);
}

function loadAuthSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(AUTH_CONFIG_FILE, 'utf8'));
    if (!settings || typeof settings.adminPassword !== 'string' || !settings.adminPassword ||
        typeof settings.loginEnabled !== 'boolean') {
      throw new Error('config.json debe incluir adminPassword y loginEnabled válidos.');
    }
    return settings;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const settings = { adminPassword: DEFAULT_ADMIN_PASSWORD, loginEnabled: false };
    saveAuthSettings(settings);
    return settings;
  }
}

const authSettings = loadAuthSettings();

if (!fs.existsSync(COMMENTS_FILE)) fs.writeFileSync(COMMENTS_FILE, COMMENTS_HEADER, 'utf8');
if (!fs.existsSync(COUNTRY_INTERACTIONS_FILE)) {
  fs.writeFileSync(COUNTRY_INTERACTIONS_FILE, COUNTRY_INTERACTIONS_HEADER, 'utf8');
}
let commentsWriteQueue = Promise.resolve();

function enqueueCommentWrite(write) {
  const operation = commentsWriteQueue.catch(() => {}).then(write);
  commentsWriteQueue = operation;
  return operation;
}

async function clearCommentsFile() {
  await enqueueCommentWrite(() => fs.promises.writeFile(COMMENTS_FILE, COMMENTS_HEADER, 'utf8'));
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function readLatestCountryInteractions() {
  let contents;
  try {
    contents = fs.readFileSync(COUNTRY_INTERACTIONS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  let latestRace = '';
  const latestCountries = new Map();
  for (const line of contents.split(/\r?\n/).slice(1)) {
    const [raceAt, id, name, count] = line.split('\t');
    if (!raceAt || !id || !name || !/^\d+$/.test(count || '')) continue;
    if (raceAt > latestRace) {
      latestRace = raceAt;
      latestCountries.clear();
    }
    if (raceAt === latestRace) {
      latestCountries.set(id, { id, name, interactions: Number(count) });
    }
  }
  return [...latestCountries.values()];
}

let latestCountryInteractions = readLatestCountryInteractions();

function tsvValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function persistCountryInteractions(data) {
  if (!data || !Array.isArray(data.countries) || data.countries.length < 1 || data.countries.length > 5) {
    throw new Error('El resultado debe incluir entre 1 y 5 países.');
  }
  const seenCountryIds = new Set();
  const countries = data.countries.map((country) => {
    if (!country || typeof country.id !== 'string' || !/^[a-z0-9_-]{1,12}$/.test(country.id) ||
        typeof country.name !== 'string' || !country.name.trim() || country.name.length > 100 ||
        !Number.isSafeInteger(country.interactions) || country.interactions < 0 ||
        seenCountryIds.has(country.id)) {
      throw new Error('El resultado contiene interacciones inválidas.');
    }
    seenCountryIds.add(country.id);
    return {
      id: country.id,
      name: country.name,
      interactions: country.interactions,
    };
  });
  const raceAt = typeof data.raceId === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.raceId)
    ? data.raceId
    : new Date().toISOString();
  const lines = countries.map((country) =>
    [raceAt, country.id, country.name, country.interactions].map(tsvValue).join('\t')).join('\n') + '\n';
  fs.appendFileSync(COUNTRY_INTERACTIONS_FILE, lines, 'utf8');
  latestCountryInteractions = countries;
  return { raceAt, countries };
}

const state = {
  status: 'idle',
  username: DEFAULT_USERNAME,
  roomId: null,
  viewerCount: 0,
  error: null,
  connectedAt: null,
};

const connectionLog = [];
function addLog(message) {
  const text = typeof message === 'string'
    ? message
    : (message && message.message ? message.message : 'Conector: error interno');
  const entry = `${new Date().toLocaleTimeString('es')} ${text}`;
  connectionLog.unshift(entry);
  if (connectionLog.length > 8) connectionLog.pop();
  broadcastStatus();
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return error && error.message ? error.message : 'Conector: error interno';
}

function sessionToken(req) {
  return (req.headers.cookie || '').split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${AUTH_COOKIE}=`))
    ?.slice(AUTH_COOKIE.length + 1);
}

function getSession(req) {
  const token = sessionToken(req);
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function setSessionCookie(req, res, token, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function passwordMatches(value) {
  const candidate = Buffer.from(String(value || ''));
  const expected = Buffer.from(authSettings.adminPassword);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (body.length + chunk.length > 4096) {
        tooLarge = true;
        body = '';
      } else if (!tooLarge) {
        body += chunk;
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Cuerpo de solicitud demasiado grande.'));
      try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function loginIsBlocked(ip) {
  const attempt = loginAttempts.get(ip);
  if (!attempt) return false;
  if (attempt.until <= Date.now()) {
    loginAttempts.delete(ip);
    return false;
  }
  return attempt.blockedUntil > Date.now();
}

function recordFailedLogin(ip) {
  const now = Date.now();
  let attempt = loginAttempts.get(ip);
  if (!attempt || attempt.until <= now) attempt = { count: 0, until: now + 15 * 60 * 1000, blockedUntil: 0 };
  attempt.count++;
  if (attempt.count >= 5) attempt.blockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(ip, attempt);
}

function requireAdmin(req, res) {
  if (!authSettings.loginEnabled) return true;
  if (getSession(req)) return true;
  json(res, 401, { error: 'Inicia sesión para continuar.' });
  return false;
}

function broadcastStatus() {
  const message = JSON.stringify({ event: 'status', data: { ...state, log: connectionLog } });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

let connection = null;
let retryTimer = null;
let retryStartedAt = 0;
let retryDelay = 3000;

function cleanUsername(value) {
  return String(value || '').trim().replace(/^@/, '').replace(/^#/, '').replace(/[/?#].*$/, '');
}

function pictureUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.url === 'string') return value.url;
  if (Array.isArray(value.urlList)) return value.urlList.find((url) => typeof url === 'string') || '';
  return '';
}

function baseUser(data = {}) {
  const user = data.user || data;
  const picture = pictureUrl(data.profilePictureUrl) || pictureUrl(data.avatar) ||
    pictureUrl(user.profilePicture) || pictureUrl(user.avatarLarge) ||
    pictureUrl(user.avatarMedium) || pictureUrl(user.avatarThumb) ||
    (user.userDetails && user.userDetails.profilePictureUrls) || '';
  return {
    uniqueId: data.uniqueId || user.uniqueId || user.nickname || 'viewer',
    nickname: data.nickname || user.nickname || data.uniqueId || user.uniqueId || 'viewer',
    profilePictureUrl: picture,
  };
}

function chatPayload(data) {
  return {
    ...baseUser(data),
    comment: data.comment || data.text || data.content || '',
  };
}

function saveComment(data) {
  const comment = String(data.comment || '');
  if (!comment.trim()) return;
  const fields = [
    new Date().toISOString(),
    data.nickname || 'Usuario',
    data.uniqueId || '',
    comment,
  ].map((value) => String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n'));

  enqueueCommentWrite(() => fs.promises.appendFile(COMMENTS_FILE, `${fields.join('\t')}\n`, 'utf8'))
    .catch((error) => console.error(`No se pudo escribir el archivo de comentarios ${COMMENTS_FILE}:`, error));
}

function broadcast(event, data) {
  const message = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 3000;
}

async function connectTikTok(username) {
  const clean = cleanUsername(username);
  if (!clean) throw new Error('Debes indicar un usuario de TikTok.');
  if (!WebcastPushConnection) {
    const connector = await import('tiktok-live-connector');
    WebcastPushConnection = connector.TikTokLiveConnection;
  }

  await disconnectTikTok();
  clearRetry();
  retryStartedAt = Date.now();
  state.username = clean;
  state.status = 'connecting';
  state.error = null;
  broadcastStatus();

  connection = new WebcastPushConnection(clean, { processInitialData: false });
  connection.on('connected', (stateInfo) => {
    clearRetry();
    state.status = 'connected';
    state.roomId = stateInfo.roomId || null;
    state.viewerCount = stateInfo.viewerCount || 0;
    state.error = null;
    state.connectedAt = new Date().toISOString();
    addLog(`Conectado a @${clean}`);
  });

  connection.on('disconnected', () => {
    if (state.status === 'disconnecting') return;
    state.status = 'disconnected';
    state.error = 'Se perdió la conexión con el live.';
    addLog('Conexión perdida');
    scheduleRetry();
  });

  connection.on('roomUser', (data) => {
    state.viewerCount = data.viewerCount || state.viewerCount;
  });

  connection.on('chat', (data) => {
    const payload = chatPayload(data);
    saveComment(payload);
    broadcast('chat', payload);
  });
  connection.on('like', (data) => broadcast('like', { ...baseUser(data), likeCount: Number(data.likeCount || data.count || 1) }));
  connection.on('follow', (data) => broadcast('follow', baseUser(data)));
  connection.on('share', (data) => broadcast('share', baseUser(data)));
  connection.on('gift', (data) => {
    if (data.giftType === 1 && data.repeatEnd !== true) return;
    broadcast('gift', { ...baseUser(data), repeatCount: Number(data.repeatCount || data.count || 1) });
  });

  connection.on('error', (error) => {
    state.error = errorText(error);
    addLog(state.error);
  });

  try {
    await connection.connect();
  } catch (error) {
    state.status = 'retrying';
    state.error = errorText(error);
    addLog(state.error);
  }

  scheduleRetry();
  return { ok: true, username: clean };
}

function scheduleRetry() {
  if (!state.username || ['connected', 'disconnecting', 'idle'].includes(state.status)) return;
  if (Date.now() - retryStartedAt >= 5 * 60 * 1000) {
    clearRetry();
    state.status = 'failed';
    return;
  }
  if (retryTimer) return;

  retryTimer = setTimeout(async () => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 1.5, 30000);
    if (state.status === 'connected') return;
    try {
      await connectTikTok(state.username);
    } catch (error) {
      state.error = error.message;
    }
  }, retryDelay);
}

async function disconnectTikTok() {
  clearRetry();
  if (connection) {
    state.status = 'disconnecting';
    try { connection.disconnect(); } catch (_) {}
  }
  connection = null;
  state.status = 'idle';
  state.roomId = null;
  state.viewerCount = 0;
  state.error = null;
  state.connectedAt = null;
  state.username = '';
  broadcastStatus();
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveOverlay(res) {
  fs.readFile(OVERLAY_FILE, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No se encontro el archivo del overlay.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': content.length,
    });
    res.end(content);
  });
}

function serveLogin(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#4f9d52"><link rel="manifest" href="/manifest.webmanifest"><title>Acceso - Carrera de tortugas</title><style>
:root{font-family:system-ui,sans-serif;color:#17351d;background:#edf7ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(360px,calc(100% - 28px));padding:20px;border:1px solid #a8c5aa;border-radius:12px;background:#fff}h1{font-size:20px;margin:0 0 14px}label{display:block;font-size:13px;font-weight:800;margin:10px 0 6px}input{width:100%;padding:10px;font-size:16px;border:1px solid #a7baa8;border-radius:7px}button{width:100%;margin-top:12px;border:0;border-radius:7px;padding:10px;background:#4f9d52;color:white;font-weight:800;font-size:15px}#remember{width:auto;margin:0 6px 0 0}#error{min-height:18px;margin-top:8px;color:#a33;font-size:13px}
</style></head><body><main><h1>Acceso a configuración</h1><form id="login"><label for="password">Contraseña de administrador</label><input id="password" type="password" autocomplete="current-password" required><label><input id="remember" type="checkbox" checked>Recordar acceso en este navegador</label><button>Entrar</button><div id="error" role="status"></div></form></main><script>
const form=document.querySelector('#login'),password=document.querySelector('#password'),error=document.querySelector('#error');
form.addEventListener('submit',async event=>{event.preventDefault();error.textContent='Verificando…';try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:password.value,remember:document.querySelector('#remember').checked})});const result=await response.json();if(!response.ok){error.textContent=result.error||'Acceso denegado';return}location.replace('/')}catch(e){error.textContent='No se pudo contactar al servidor'}});
</script></body></html>`);
}

function serveConfig(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexión TikTok</title><style>
:root{font-family:system-ui,sans-serif;color:#17351d;background:#edf7ef}*{box-sizing:border-box}body{margin:0;min-height:100vh}main{width:min(850px,calc(100% - 28px));margin:14px auto;padding:18px;border:1px solid #a8c5aa;border-radius:12px;background:#fff}h1{font-size:20px;margin:0 0 14px}h2{font-size:16px;margin:0 0 8px}label{display:block;font-size:13px;font-weight:800;margin-bottom:6px}input{width:100%;padding:9px;font-size:15px;border:1px solid #a7baa8;border-radius:7px}.actions{display:flex;gap:7px;margin-top:9px}button{border:0;border-radius:7px;padding:8px 12px;font-weight:800;cursor:pointer}#connect{background:#4f9d52;color:white}#disconnect{background:#e7eee8}#overlay,#countries,#install{width:100%;margin-top:9px;background:#1f6f43;color:white}#status,#fileStatus,#settingsStatus{margin-top:10px;font-size:13px;color:#425347}#log,.fileContent{margin:8px 0 0;padding:8px 10px;min-height:48px;max-height:230px;overflow:auto;border-radius:7px;background:#f3f7f3;font-family:ui-monospace,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.fileGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:16px}.fileCard{min-width:0;padding:12px;border:1px solid #c5d8c6;border-radius:9px}.fileActions{display:flex;gap:7px;margin-top:8px}.fileActions button{flex:1;background:#e7eee8}.fileActions .clear{background:#a33;color:white}.fileContent:empty::before{content:"Sin registros"}#authSettings{margin-top:16px}#authSettings input[type=checkbox]{width:auto;margin:0 7px 0 0}#authSettings #saveSettings{margin-top:8px;background:#1f6f43;color:white}
</style><meta name="theme-color" content="#4f9d52"><link rel="manifest" href="/manifest.webmanifest"></head><body><main><h1>Conexión TikTok</h1><label for="username">Usuario</label><input id="username" placeholder="usuario_del_live" autocomplete="off"><div class="actions"><button id="connect">Conectar</button><button id="disconnect">Desconectar</button></div><button id="overlay">Abrir overlay</button><button id="countries">🏳️ Países y banderas</button><button id="install" hidden>Instalar en Android</button><div id="status">Consultando…</div><pre id="log"></pre><section class="fileCard" id="authSettings"><h2>Acceso al panel</h2><label><input id="loginEnabled" type="checkbox">Exigir contraseña para el panel</label><label for="adminPassword">Nueva contraseña (deja vacío para conservarla)</label><input id="adminPassword" type="password" autocomplete="new-password" maxlength="256"><button id="saveSettings">Guardar ajustes</button><div id="settingsStatus" role="status"></div></section><section class="fileGrid">
<article class="fileCard"><h2>Comentarios del live</h2><pre class="fileContent" id="commentsFile"></pre><div class="fileActions"><button id="copyComments">Copiar comentarios</button><button class="clear" id="clearComments">Vaciar archivo</button></div></article>
<article class="fileCard"><h2>Interacciones por país</h2><pre class="fileContent" id="interactionsFile"></pre><div class="fileActions"><button id="copyInteractions">Copiar interacciones</button><button class="clear" id="clearInteractions">Vaciar archivo</button></div></article>
</section><div id="fileStatus" role="status"></div></main><script>
const username=document.querySelector('#username'),status=document.querySelector('#status'),log=document.querySelector('#log');
async function refresh(){const r=await fetch('/api/status',{cache:'no-store'});if(r.status===401){location.replace('/login');return}const s=await r.json();username.value=username.value||s.username||'';status.textContent='Estado: '+s.status+(s.error?' — '+s.error:'');log.textContent=(s.log||[]).join('\\n')}
const loginEnabled=document.querySelector('#loginEnabled'),adminPassword=document.querySelector('#adminPassword'),settingsStatus=document.querySelector('#settingsStatus');
async function refreshSettings(){const r=await fetch('/api/settings',{cache:'no-store'});if(r.status===401){location.replace('/login');return}const s=await r.json();if(!r.ok)throw new Error(s.error||'No se pudieron leer los ajustes');loginEnabled.checked=s.loginEnabled}
document.querySelector('#saveSettings').onclick=async()=>{settingsStatus.textContent='Guardando…';try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginEnabled:loginEnabled.checked,password:adminPassword.value})});const result=await r.json();if(r.status===401){location.replace('/login');return}if(!r.ok)throw new Error(result.error||'No se pudieron guardar los ajustes');adminPassword.value='';loginEnabled.checked=result.loginEnabled;settingsStatus.textContent='Ajustes guardados';}catch(e){settingsStatus.textContent=e.message}};
const fileStatus=document.querySelector('#fileStatus');
async function fetchFile(file){const r=await fetch('/api/logs/'+file,{cache:'no-store'});const d=await r.json();if(r.status===401){location.replace('/login');throw new Error('Sesión finalizada')}if(!r.ok)throw new Error(d.error||'No se pudo leer el archivo');document.querySelector(file==='comments'?'#commentsFile':'#interactionsFile').textContent=d.content}
async function refreshFiles(){try{await Promise.all([fetchFile('comments'),fetchFile('interactions')]);fileStatus.textContent='Archivos actualizados'}catch(e){fileStatus.textContent=e.message}}
async function copyFile(file,label){try{const text=document.querySelector(file==='comments'?'#commentsFile':'#interactionsFile').textContent;if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error('El navegador no permitió copiar')}fileStatus.textContent=label+' copiados'}catch(e){fileStatus.textContent='No se pudo copiar: '+e.message}}
async function clearFile(file,label){if(!confirm('¿Vaciar el archivo de '+label+'? Esta acción no se puede deshacer.'))return;try{const r=await fetch('/api/logs/'+file+'/clear',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo vaciar el archivo');await refreshFiles();fileStatus.textContent='Archivo de '+label+' vaciado'}catch(e){fileStatus.textContent=e.message}}
document.querySelector('#connect').onclick=async()=>{status.textContent='Conectando…';const r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username.value})});const s=await r.json();if(!r.ok)status.textContent='Error: '+(s.error||'No se pudo conectar');await refresh()};
document.querySelector('#disconnect').onclick=async()=>{await fetch('/api/disconnect',{method:'POST'});await refresh()};
document.querySelector('#overlay').onclick=()=>{const socket=(location.protocol==='https:'?'wss://':'ws://')+location.host;window.open('/overlay?ws='+encodeURIComponent(socket),'_blank','noopener')};
document.querySelector('#countries').onclick=()=>window.open('/overlay?countries=1','_blank','noopener');
document.querySelector('#overlay').insertAdjacentHTML('afterend','<button id="testevents" style="width:100%;margin-top:7px">Prueba todos los eventos</button>');
document.querySelector('#testevents').onclick=async()=>{await fetch('/api/test-events',{method:'POST'});};
document.querySelector('#copyComments').onclick=()=>copyFile('comments','Comentarios');
document.querySelector('#copyInteractions').onclick=()=>copyFile('interactions','Interacciones');
document.querySelector('#clearComments').onclick=()=>clearFile('comments','comentarios');
document.querySelector('#clearInteractions').onclick=()=>clearFile('interactions','interacciones');
document.querySelector('#install').insertAdjacentHTML('afterend','<button id="logout" style="width:100%;margin-top:7px">Cerrar sesión</button>');
document.querySelector('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.replace('/login')};
let installPrompt;const installButton=document.querySelector('#install');
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;installButton.hidden=false});
installButton.onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;installButton.hidden=true};
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost' || location.hostname==='127.0.0.1')){
  navigator.serviceWorker.register('/sw.js').catch(error=>console.error('No se pudo registrar la app instalable',error));
}
refresh();refreshSettings().catch(error=>settingsStatus.textContent=error.message);refreshFiles();setInterval(refresh,3000);setInterval(refreshFiles,5000);
</script></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const staticAssets = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
    '/icon.svg': ['icon.svg', 'image/svg+xml'],
  };
  const asset = staticAssets[url.pathname];
  if (req.method === 'GET' && asset) {
    fs.readFile(path.join(__dirname, asset[0]), (error, content) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No se encontro el recurso.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': asset[0] === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
        ...(asset[0] === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
        'Content-Length': content.length,
      });
      res.end(content);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/overlay') {
    return serveOverlay(res);
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    if (!authSettings.loginEnabled || getSession(req)) {
      res.writeHead(303, { Location: '/' });
      return res.end();
    }
    return serveLogin(res);
  }
  if (req.method === 'GET' && (url.pathname === '/config' || url.pathname === '/')) {
    if (authSettings.loginEnabled && !getSession(req)) {
      res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return serveConfig(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!authSettings.loginEnabled) return json(res, 200, { ok: true });
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginIsBlocked(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    try {
      const payload = await readJson(req);
      if (!passwordMatches(payload.password)) {
        recordFailedLogin(ip);
        return json(res, 401, { error: 'Contraseña incorrecta.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      const ttl = payload.remember === true ? SESSION_TTL_MS : 12 * 60 * 60 * 1000;
      sessions.set(token, Date.now() + ttl);
      setSessionCookie(req, res, token, Math.floor(ttl / 1000));
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = sessionToken(req);
    if (token) sessions.delete(token);
    setSessionCookie(req, res, '', 0);
    return json(res, 200, { ok: true });
  }
  const logFileRoute = ['/api/logs/comments', '/api/logs/interactions'].includes(url.pathname);
  const logReadRoute = req.method === 'GET' && logFileRoute;
  const logClearRoute = req.method === 'POST' &&
    ['/api/logs/comments/clear', '/api/logs/interactions/clear'].includes(url.pathname);
  const settingsRoute = url.pathname === '/api/settings' &&
    ['GET', 'POST'].includes(req.method);
  const adminRoute = settingsRoute ||
    (req.method === 'GET' && url.pathname === '/api/status') ||
    (req.method === 'POST' && ['/api/connect', '/api/disconnect', '/api/test-events'].includes(url.pathname)) ||
    logReadRoute || logClearRoute;
  if (adminRoute && !requireAdmin(req, res)) return;

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return json(res, 200, { loginEnabled: authSettings.loginEnabled });
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let payload;
    try {
      payload = await readJson(req);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    if (!payload || typeof payload.loginEnabled !== 'boolean' ||
        (payload.password !== undefined &&
          (typeof payload.password !== 'string' || payload.password.length > 256))) {
      return json(res, 400, { error: 'Los ajustes de acceso no son válidos.' });
    }

    const nextSettings = {
      loginEnabled: payload.loginEnabled,
      adminPassword: payload.password ? payload.password : authSettings.adminPassword,
    };
    try {
      saveAuthSettings(nextSettings);
    } catch (error) {
      console.error('No se pudieron guardar los ajustes de acceso:', error);
      return json(res, 500, { error: 'No se pudieron guardar los ajustes de acceso.' });
    }

    authSettings.loginEnabled = nextSettings.loginEnabled;
    authSettings.adminPassword = nextSettings.adminPassword;
    sessions.clear();
    loginAttempts.clear();
    if (authSettings.loginEnabled) {
      const token = crypto.randomBytes(32).toString('base64url');
      const ttl = 12 * 60 * 60 * 1000;
      sessions.set(token, Date.now() + ttl);
      setSessionCookie(req, res, token, Math.floor(ttl / 1000));
    } else {
      setSessionCookie(req, res, '', 0);
    }
    return json(res, 200, { ok: true, loginEnabled: authSettings.loginEnabled });
  }

  if (req.method === 'GET' && url.pathname === '/api/logs/comments') {
    try {
      return json(res, 200, { content: readTextFile(COMMENTS_FILE) });
    } catch (error) {
      console.error('No se pudo leer el archivo de comentarios:', error);
      return json(res, 500, { error: 'No se pudo leer el archivo de comentarios.' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/logs/interactions') {
    try {
      return json(res, 200, { content: readTextFile(COUNTRY_INTERACTIONS_FILE) });
    } catch (error) {
      console.error('No se pudo leer el archivo de interacciones:', error);
      return json(res, 500, { error: 'No se pudo leer el archivo de interacciones.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/logs/comments/clear') {
    try {
      await clearCommentsFile();
      return json(res, 200, { ok: true });
    } catch (error) {
      console.error('No se pudo vaciar el archivo de comentarios:', error);
      return json(res, 500, { error: 'No se pudo vaciar el archivo de comentarios.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/logs/interactions/clear') {
    try {
      fs.writeFileSync(COUNTRY_INTERACTIONS_FILE, COUNTRY_INTERACTIONS_HEADER, 'utf8');
      latestCountryInteractions = [];
      return json(res, 200, { ok: true });
    } catch (error) {
      console.error('No se pudo vaciar el archivo de interacciones:', error);
      return json(res, 500, { error: 'No se pudo vaciar el archivo de interacciones.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, { ...state, log: connectionLog });
  }
  if (req.method === 'POST' && url.pathname === '/api/connect') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await connectTikTok(payload.username);
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/disconnect') {
    await disconnectTikTok();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/test-events') {
    const avatar = 'data:image/svg+xml;base64,' + Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#4f9d52"/><circle cx="32" cy="24" r="12" fill="#fff"/><path d="M10 62c2-15 10-23 22-23s20 8 22 23" fill="#fff"/></svg>',
    ).toString('base64');
    const user = {
      uniqueId: 'test_tortuga',
      nickname: 'Prueba',
      profilePictureUrl: avatar,
    };
    const events = [
      ['chat', chatPayload({ ...user, content: 'Colombia' })],
      ['like', { ...user, likeCount: 3 }],
      ['follow', user],
      ['share', user],
      ['gift', { ...user, repeatCount: 2 }],
    ];
    events.forEach(([event, data], index) => {
      setTimeout(() => broadcast(event, data), index * 700);
    });
    return json(res, 200, { ok: true, sent: 5, events: events.map(([event]) => event) });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ event: 'status', data: { ...state, log: connectionLog } }));
  socket.send(JSON.stringify({ event: 'race-history', data: { countries: latestCountryInteractions } }));
  socket.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.event !== 'race-result') return;
      const result = persistCountryInteractions(payload.data);
      socket.send(JSON.stringify({ event: 'race-result-saved', data: { raceId: result.raceAt } }));
    } catch (error) {
      console.error('No se pudieron guardar las interacciones por país:', error);
      socket.send(JSON.stringify({ event: 'race-result-error', data: { error: error.message } }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor HTTP/WebSocket activo en http://${HOST}:${PORT}`);
  console.log(`Overlay: http://${HOST}:${PORT}/overlay`);
  console.log(`Configuracion: http://${HOST}:${PORT}/config`);
  connectTikTok(DEFAULT_USERNAME).catch((error) => {
    state.status = 'failed';
    state.error = error.message;
  });
});
