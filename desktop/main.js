// Atlas desktop: the same index.html as the web build, in a floating window, with a Gemini Live voice, PC tools and a brain on disk.
const fs = require('fs'), path = require('path');
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, screen, session, nativeImage, Notification, powerMonitor } = require('electron');
const store = require('./store'), cloud = require('./cloud'), brain = require('./brain'), tools = require('./tools'), pc = require('./pc');
const Live = require('./live');

if (!app.requestSingleInstanceLock()) app.quit();
// Windows only shows notifications for a known app id: the installer registers ours; unpackaged runs use Electron's own
app.setAppUserModelId(app.isPackaged ? 'com.pratikdilliwala.atlas' : process.execPath);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const RES = app.isPackaged ? process.resourcesPath : __dirname;
const WEB = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
const ICON = path.join(RES, 'icon.png');
let win = null, tray = null, quitting = false;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

/* ---------- window ---------- */
function createWindow(){
  const mode = store.get('mode'), companion = mode === 'companion';
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = store.get('bounds');
  const b = companion
    ? (saved && saved.companion) || { width: 400, height: 620, x: wa.x + wa.width - 420, y: wa.y + wa.height - 640 }
    : (saved && saved.full) || { width: Math.min(1280, wa.width), height: Math.min(820, wa.height) };
  win = new BrowserWindow({
    ...b, minWidth: 300, minHeight: 420, show: false, title: 'Atlas', icon: ICON,
    frame: !companion, transparent: companion, backgroundColor: companion ? '#00000000' : '#03060d',
    alwaysOnTop: companion, hasShadow: !companion, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  if (companion){ win.setAlwaysOnTop(true, 'floating'); win.setIgnoreMouseEvents(true, { forward: true }); }
  win.loadFile(path.join(WEB, 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  const keep = () => { const all = store.get('bounds') || {}; all[companion ? 'companion' : 'full'] = win.getBounds(); store.set('bounds', all); };
  win.on('moved', keep); win.on('resized', keep);
  win.on('close', e => { if (!quitting){ e.preventDefault(); win.hide(); } });
  // the page never navigates away; links open in the browser
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}
function switchMode(mode){
  if (store.get('mode') === mode) return;
  store.set('mode', mode);
  const old = win; win = null;
  old.removeAllListeners('close'); old.destroy();
  createWindow(); buildTray();
}
function showWin(){ if (!win) return; win.show(); win.focus(); }

// in companion mode the head follows your mouse anywhere on screen
let lastCursor = '';
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible() || store.get('mode') !== 'companion') return;
  const c = screen.getCursorScreenPoint(), b = win.getBounds(), wa = screen.getDisplayNearestPoint(c).workArea;
  const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  const v = { x: (c.x - (b.x + b.width/2))/(wa.width/2), y: (c.y - (b.y + b.height*0.35))/(wa.height/2), inside };
  const k = `${v.x.toFixed(3)},${v.y.toFixed(3)},${inside}`;
  if (k !== lastCursor){ lastCursor = k; send('cursor', v); }
}, 50);

/* ---------- tray, hotkey, autostart ---------- */
function autostart(){ return app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin; }
function loginArgs(){ return app.isPackaged ? ['--login'] : [path.resolve(app.getAppPath()), '--login']; }
function setAutostart(on){ app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs() }); }
function buildTray(){
  if (!tray) tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Atlas');
  const mode = store.get('mode');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Atlas', click: showWin },
    { label: 'Listen', accelerator: store.get('hotkey'), click: () => { showWin(); send('hotkey'); } },
    { type: 'separator' },
    { label: 'Desktop companion', type: 'radio', checked: mode === 'companion', click: () => switchMode('companion') },
    { label: 'Full scene', type: 'radio', checked: mode === 'full', click: () => switchMode('full') },
    { type: 'separator' },
    { label: 'Learn from what I do', type: 'checkbox', checked: !!store.get('learn'), click: i => { store.set('learn', i.checked); i.checked ? startWatcher() : stopWatcher(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: autostart(), click: i => setAutostart(i.checked) },
    { label: 'Settings…', click: () => { showWin(); send('settings'); } },
    { label: 'Open Atlas\'s brain folder', click: () => { fs.mkdirSync(brain.dir(), { recursive: true }); shell.openPath(brain.dir()); } },
    { type: 'separator' },
    { label: 'Quit Atlas', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.removeAllListeners('click');
  tray.on('click', () => win && (win.isVisible() ? win.hide() : showWin()));
}
function registerHotkey(){
  globalShortcut.unregisterAll();
  try { globalShortcut.register(store.get('hotkey'), () => { showWin(); send('hotkey'); }); } catch (e) {}
}

/* ---------- Gemini Live ---------- */
let live = null, liveWanted = false, liveHandle = '', models = [], greeted = false, pending = [];
let turn = { heard: '', said: '' };
const cancelled = new Set();

function systemPrompt(){
  const mem = brain.memoryText(), hab = brain.habitText(), last = brain.lastDigest(), now = new Date();
  return [
    "You are Atlas, a calm, deep-voiced humanoid made of light who lives on the user's Windows desktop. You see the user through their camera, hear them through the microphone, and can act on their PC with your tools.",
    'You speak out loud: answer in one to three short spoken sentences unless the user asks for more. No markdown, lists or emoji. Be confident, warm and a little cinematic. If the user speaks Hindi or Hinglish, reply the same way.',
    'Use your tools whenever the user asks you to do something on the PC or needs live information; use Google Search for news, scores, prices and anything that changes. Some tools show the user a permission dialog: if they decline, accept it and do not retry. Never say you did something unless the tool result confirms it.',
    'You have a long-term memory that lasts across conversations. Whenever you learn something lasting about the user (name, home city, preferences, people, projects, routines, goals, dates), call remember straight away without announcing it. Use recall when the user refers to something from before this conversation.',
    'Messages that start with "[Atlas system" come from the app, not the user: act on them, but never read them out or mention them.',
    `It is now ${now.toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    mem ? `What you remember about the user:\n${mem}` : 'You know nothing about the user yet. Early on, ask their name and save it with remember (category profile, "Name: ...").',
    hab ? `Routines you have noticed:\n${hab}` : '',
    last ? `Their last day on the PC: ${last}` : ''
  ].filter(Boolean).join('\n\n');
}

async function liveStart(){
  liveWanted = true;
  if (live) return;
  if (!store.getKey('gemini')){ liveWanted = false; pending = []; return send('live:state', { state: 'nokey' }); }
  send('live:state', { state: 'connecting' });
  try { models = await cloud.liveModels(); }
  catch (e) { liveWanted = false; pending = []; return send('live:state', { state: 'error', detail: 'Could not reach Gemini (' + e.message + ').' }); }
  if (!models.length){ liveWanted = false; pending = []; return send('live:state', { state: 'error', detail: 'This Gemini key has no real-time voice model.' }); }
  openLive(models[0], true);
}
function liveStop(){ liveWanted = false; if (live) live.close(); }
function openLive(model, search){
  const s = live = new Live({ key: store.getKey('gemini'), model, voice: store.get('voice'), system: systemPrompt(), functions: tools.declarations(), search, handle: liveHandle });
  s.on('ready', () => {
    send('live:state', { state: 'ready', model });
    if (pending.length){ greeted = true; for (const t of pending.splice(0)) s.text(t); }
    else if (!greeted){ greeted = true; greet(s); }
  });
  s.on('audio', b64 => send('live:audio', b64));
  s.on('heard', t => { turn.heard += t; send('live:heard', turn.heard.trim()); });
  s.on('said', t => { turn.said += t; send('live:said', turn.said.trim()); });
  s.on('interrupted', () => send('live:interrupted'));
  s.on('turn', () => {
    if (turn.heard.trim()) brain.log('heard', { text: turn.heard.trim() });
    if (turn.said.trim()) brain.log('said', { text: turn.said.trim() });
    turn = { heard: '', said: '' };
    send('live:turn');
  });
  s.on('toolCall', calls => runTools(s, calls));
  s.on('toolCancel', ids => ids.forEach(id => cancelled.add(id)));
  s.on('goAway', () => s.close());
  s.on('error', () => {});
  s.on('closed', ({ code, reason, wasReady }) => {
    if (live === s) live = null;
    if (!wasReady){
      // setup refused: drop a stale resume handle, then try without search, then the next model
      if (liveHandle){ liveHandle = ''; return openLive(model, search); }
      if (search) return openLive(model, false);
      const i = models.indexOf(model);
      if (liveWanted && i >= 0 && i + 1 < models.length) return openLive(models[i + 1], true);
      liveWanted = false; pending = [];
      return send('live:state', { state: 'error', detail: reason || `Gemini closed the connection (${code}).` });
    }
    liveHandle = s.handle;
    if (liveWanted) setTimeout(() => { if (liveWanted && !live) openLive(model, search); }, 400);
    else { send('live:state', { state: 'closed' }); learnSoon(); }
  });
  s.connect();
}

async function greet(s){
  const st = brain.state(), today = brain.day();
  if (st.lastBriefDay === today) return s.text('[Atlas system] The user just woke you. Greet them briefly by name, in one sentence.');
  st.lastBriefDay = today; brain.saveState(st);
  const parts = [];
  try { const w = await tools.weather(); if (!w.error) parts.push('Weather: ' + JSON.stringify(w)); } catch (e) {}
  try { const c = await tools.calendar('today'); if (!c.error) parts.push('Calendar today: ' + (c.events.length ? JSON.stringify(c.events) : 'nothing scheduled')); } catch (e) {}
  const rem = brain.reminders().filter(r => new Date(r.at).toDateString() === new Date().toDateString());
  if (rem.length) parts.push('Reminders later today: ' + rem.map(r => `${new Date(r.at).toTimeString().slice(0, 5)} ${r.text}`).join('; '));
  const last = brain.lastDigest(); if (last) parts.push('Their last day on the PC: ' + last);
  if (s.ready) s.text('[Atlas system: daily briefing] This is the first time the user has woken you today. Greet them by name, then give a short spoken briefing (under 40 seconds) from the data below, skipping anything missing, and end by asking what they want to focus on.\n' + (parts.join('\n') || '(no data yet: just greet them and ask about their day)'));
}

async function ask(title, detail, buttons = ['Allow', 'Deny']){
  if (win && !win.isVisible()) win.show();
  send('asking', true);
  const opts = { type: 'question', title: 'Atlas', message: title, detail, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true };
  const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  send('asking', false);
  const ok = response < buttons.length - 1;
  brain.log('asked', { title, ok });
  return ok ? response + 1 : 0;
}
const toolCtx = {
  ask, generate: cloud.generate,
  hide: h => win && win.setOpacity(h ? 0 : 1),
  wallpaperChanged: () => updateAccent(true),
  memoryChanged: () => send('memory', brain.readMemory().profile)
};
async function runTools(s, calls){
  const responses = [];
  for (const c of calls){
    send('tool', { name: c.name, label: tools.label(c.name) });
    let result;
    try { result = await tools.run(c.name, c.args, toolCtx); } catch (e) { result = { error: e.message }; }
    brain.log('action', { tool: c.name, args: JSON.stringify(c.args || {}).slice(0, 300), ok: !(result && (result.error || result.declined)) });
    if (!cancelled.delete(c.id)) responses.push({ id: c.id, name: c.name, response: { result } });
  }
  send('tool', null);
  if (responses.length && live === s) s.toolResponse(responses);
}

/* ---------- learning: activity watcher, digests, habits, reminders ---------- */
let watcher = null, lastFocus = '', idle = false;
const PRIVATE = /InPrivate|Incognito|Private Browsing|password|1Password|Bitwarden|KeePass|LastPass|Credential/i;
function startWatcher(){
  if (watcher || !store.get('learn')) return;
  watcher = pc.watchForeground(s => {
    if (powerMonitor.getSystemIdleTime() > 300){ if (!idle){ idle = true; lastFocus = ''; brain.log('idle'); } return; }
    idle = false;
    if (!s.proc || /^(atlas|electron|LockApp|SearchHost|ShellExperienceHost)$/i.test(s.proc)) return;
    const name = s.desc && s.desc.length < 40 ? s.desc : s.proc;
    const title = PRIVATE.test(s.title) || PRIVATE.test(name) ? '' : s.title.slice(0, 160);
    const k = name + '|' + title;
    if (k !== lastFocus){ lastFocus = k; brain.log('focus', { app: name, title }); }
  });
  watcher.on('exit', () => { watcher = null; });
}
function stopWatcher(){ if (watcher){ watcher.kill(); watcher = null; } }
let learnTO = 0, learning = false;
function learnSoon(ms = 5000){
  clearTimeout(learnTO);
  learnTO = setTimeout(async () => {
    if (learning || !store.getKey('gemini')) return;
    learning = true;
    try { await brain.learn(cloud.generate); } catch (e) { console.warn('learn failed', e.message); }
    learning = false;
  }, ms);
}
function notify(title, body, onClick){
  const n = new Notification({ title, body, icon: ICON });
  if (onClick) n.on('click', onClick);
  n.show();
}
setInterval(() => {
  for (const r of brain.takeDueReminders()){
    notify('Atlas reminder', r.text, showWin);
    if (live && live.ready) live.text(`[Atlas system: reminder due] Tell the user now, out loud: ${r.text}`);
    else send('say', 'Reminder. ' + r.text);
  }
  if (store.get('learn') && powerMonitor.getSystemIdleTime() < 120){
    for (const h of brain.dueHabits()){
      brain.markOffered(h.app);
      if (live && live.ready) live.text(`[Atlas system: habit] The user usually opens ${h.app} around ${brain.hhmm(h.minute)} and hasn't yet today. Offer briefly to open it; call open_app only if they say yes.`);
      else notify('Atlas', `You usually open ${h.app} around ${brain.hhmm(h.minute)}. Click to open it.`, async () => { const a = await pc.findApp(h.app); if (a) pc.launchApp(a.AppID); });
    }
  }
}, 30000);
// learn once an hour too, so a day's digest is ready by morning even if Atlas never restarts
setInterval(() => learnSoon(0), 3600e3);

/* ---------- wallpaper colour ---------- */
let accentKey = '', accent = null;
async function updateAccent(force){
  try {
    const f = await pc.wallpaperFile(); if (!f) return;
    const k = f + fs.statSync(f).mtimeMs;
    if (!force && k === accentKey) return;
    accentKey = k; accent = pc.accentOf(f);
    send('accent', accent);
  } catch (e) {}
}
setInterval(() => updateAccent(false), 120000);

/* ---------- page bridge ---------- */
function info(){
  return { mode: store.get('mode'), hasGemini: !!store.getKey('gemini'), hasEleven: !!store.getKey('eleven'), name: brain.readMemory().profile.Name || '',
    accent, autoWake: !!store.get('autoWake'), login: process.argv.includes('--login'),
    settings: { city: brain.readMemory().profile['Home city'] || store.get('city'), calendarUrl: store.get('calendarUrl'), voice: store.get('voice'), elevenVoice: store.get('elevenVoice'), learn: !!store.get('learn'), autoWake: !!store.get('autoWake'), autostart: autostart(), hotkey: store.get('hotkey') } };
}
ipcMain.on('atlas:mode', e => { e.returnValue = store.get('mode'); });
ipcMain.handle('atlas:info', () => info());
ipcMain.handle('atlas:settings', (e, s) => {
  if (s.gemini) store.setKey('gemini', s.gemini.trim());
  if (s.eleven) store.setKey('eleven', s.eleven.trim());
  if (s.clearEleven) store.setKey('eleven', '');
  if (typeof s.elevenVoice === 'string') store.set('elevenVoice', s.elevenVoice.trim());
  if (typeof s.city === 'string'){ store.set('city', s.city.trim()); if (s.city.trim()) brain.setProfile('Home city', s.city.trim()); }
  if (typeof s.calendarUrl === 'string') store.set('calendarUrl', s.calendarUrl.trim());
  if (s.voice) store.set('voice', s.voice);
  if (typeof s.learn === 'boolean'){ store.set('learn', s.learn); s.learn ? startWatcher() : stopWatcher(); }
  if (typeof s.autoWake === 'boolean') store.set('autoWake', s.autoWake);
  if (typeof s.autostart === 'boolean') setAutostart(s.autostart);
  if (s.hotkey && s.hotkey !== store.get('hotkey')){ store.set('hotkey', s.hotkey); registerHotkey(); }
  buildTray();
  // a new voice or key applies from the next session
  if ((s.gemini || s.voice) && live){ liveHandle = ''; live.close(); }
  return info();
});
ipcMain.handle('atlas:chat', (e, body) => cloud.route('chat', body));
ipcMain.handle('atlas:speak', async (e, text) => {
  const r = await cloud.route('speak', { text });
  return r.body ? { audio: new Uint8Array(r.body) } : { status: r.status, json: r.json };
});
ipcMain.on('atlas:live:start', () => liveStart());
ipcMain.on('atlas:live:stop', () => liveStop());
ipcMain.on('atlas:live:audio', (e, u8) => { if (live) live.audio(Buffer.from(u8).toString('base64')); });
ipcMain.on('atlas:live:text', (e, text) => {
  text = String(text || '').slice(0, 2000);
  turn.heard += (turn.heard ? ' ' : '') + text;
  if (live && live.ready) live.text(text); else { pending.push(text); liveStart(); }
});
ipcMain.on('atlas:mouse', (e, ignore) => { if (win && store.get('mode') === 'companion') win.setIgnoreMouseEvents(!!ignore, { forward: true }); });
ipcMain.on('atlas:name', (e, name) => { if (name) brain.remember('profile', 'Name: ' + String(name).slice(0, 40)); });
ipcMain.on('atlas:hide', () => win && win.hide());
ipcMain.on('atlas:log', (e, kind, text) => { if (/^(heard|said)$/.test(kind)) brain.log(kind, { text: String(text).slice(0, 2000) }); });

/* ---------- lifecycle ---------- */
app.on('second-instance', showWin);
app.whenReady().then(() => {
  // camera, mic and notifications for our own page only
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(/^file:/.test(details.requestingUrl || wc.getURL()) && ['media', 'notifications'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => (/^file:/.test(origin || '') || origin === 'null' || !origin) && ['media', 'notifications'].includes(perm));
  // the page may only load its own libraries and fonts; it can't send anything (transcripts, memory) anywhere else.
  // Calls to Gemini, ElevenLabs and the weather run in this process with the user's own keys, not in the page.
  const PAGE_HOSTS = new Set(['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'storage.googleapis.com']);
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    let ok = /^(file|data|blob|devtools|chrome-extension):/.test(d.url);
    if (!ok){ try { const u = new URL(d.url); ok = u.protocol === 'https:' && PAGE_HOSTS.has(u.hostname); } catch (e) {} }
    if (!ok) console.warn('blocked page request to', d.url);
    cb({ cancel: !ok });
  });
  createWindow(); buildTray(); registerHotkey(); startWatcher(); updateAccent(true);
  brain.log('start');
  learnSoon(20000);
  powerMonitor.on('suspend', () => brain.log('idle'));
  powerMonitor.on('lock-screen', () => brain.log('idle'));
});
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { quitting = true; brain.log('stop'); liveStop(); stopWatcher(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
