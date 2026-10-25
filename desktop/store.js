// Settings and API keys, kept in the user's AppData folder. Keys are encrypted with Windows' own data protection (safeStorage).
const fs = require('fs'), path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = { mode: 'companion', hotkey: 'Control+Shift+Space', voice: 'Charon', elevenVoice: '', liveModel: '', learn: true, autoWake: true, city: '', calendarUrl: '', bounds: null };
const ENV = { gemini: 'GEMINI_API_KEY', eleven: 'ELEVENLABS_API_KEY' };
let data = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');
function load(){
  if (data) return data;
  try { data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch (e) { data = { ...DEFAULTS }; }
  return data;
}
function save(){ fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(data, null, 2)); }
const get = k => load()[k];
function set(k, v){ load()[k] = v; save(); }

// dev convenience: a .env.local in the repo (from `vercel env pull`) fills in keys that were never saved in the app
function envFile(){
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)){
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/); if (m) out[m[1]] = m[2];
    }
  } catch (e) {}
  return out;
}
function getKey(name){
  const enc = (load().keys || {})[name];
  if (enc){ try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) {} }
  return process.env[ENV[name]] || (!app.isPackaged && envFile()[ENV[name]]) || '';
}
function setKey(name, value){
  const keys = load().keys || {};
  if (value) keys[name] = safeStorage.encryptString(value).toString('base64'); else delete keys[name];
  data.keys = keys; save();
}

module.exports = { get, set, getKey, setKey };
