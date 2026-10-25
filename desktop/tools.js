// What Atlas can do on the PC. Each tool is either "safe" (runs at once) or "ask" (a Windows dialog asks you first).
// Nothing here deletes permanently: removal goes to the Recycle Bin, and memory edits are shown before they happen.
const fs = require('fs'), os = require('os'), path = require('path');
const { shell, clipboard, desktopCapturer, Notification, screen } = require('electron');
const pc = require('./pc'), brain = require('./brain'), store = require('./store');

const S = (description, extra = {}) => ({ type: 'STRING', description, ...extra });
const N = description => ({ type: 'NUMBER', description });
const obj = (properties, required = []) => ({ type: 'OBJECT', properties, required });

const EXEC = /\.(exe|bat|cmd|com|msi|ps1|vbs|js|jse|wsf|scr|lnk|reg|hta|cpl|jar)$/i;
const SENSITIVE = /[\\/](\.ssh|\.gnupg|\.aws|\.azure|AppData)[\\/]|\.env\b|id_rsa|\.pem$|\.key$|\.kdbx$|password/i;
const expand = p => path.resolve(String(p || '').replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%([^%]+)%/g, (_, v) => process.env[v] || ''));
const inLibrary = p => pc.userFolders().some(f => p.toLowerCase().startsWith(f.toLowerCase() + path.sep) || p.toLowerCase() === f.toLowerCase());
const short = (s, n = 600) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

const WX = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };
async function weather(city){
  city = city || brain.readMemory().profile['Home city'] || store.get('city');
  if (!city) return { error: 'no_city', hint: 'Ask the user which city they live in, then save it with remember (category profile, "Home city: <city>").' };
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)).json();
  const loc = g.results && g.results[0];
  if (!loc) return { error: 'city_not_found', city };
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&timezone=auto&forecast_days=2` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code')).json();
  const c = w.current || {}, d = w.daily || {};
  return { place: `${loc.name}, ${loc.country}`, now: { temp_c: c.temperature_2m, feels_c: c.apparent_temperature, sky: WX[c.weather_code] || c.weather_code, wind_kmh: c.wind_speed_10m, humidity: c.relative_humidity_2m },
    today: d.time && { high_c: d.temperature_2m_max[0], low_c: d.temperature_2m_min[0], rain_chance: d.precipitation_probability_max[0], sky: WX[d.weather_code[0]] },
    tomorrow: d.time && { high_c: d.temperature_2m_max[1], low_c: d.temperature_2m_min[1], rain_chance: d.precipitation_probability_max[1], sky: WX[d.weather_code[1]] } };
}

// a small iCal reader: single events plus simple daily/weekly repeats, enough for a briefing
function icsDate(v){
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  if (!m[4]) return { d: new Date(+m[1], m[2]-1, +m[3]), allDay: true };
  return { d: m[7] ? new Date(Date.UTC(+m[1], m[2]-1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], m[2]-1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
}
async function calendar(which = 'today'){
  const url = store.get('calendarUrl');
  if (!url) return { error: 'no_calendar', hint: 'The user can paste their calendar\'s secret iCal address in Atlas settings (Google Calendar: Settings → your calendar → Secret address in iCal format).' };
  const txt = (await (await fetch(url.replace(/^webcal:/, 'https:'))).text()).replace(/\r?\n[ \t]/g, '');
  const target = new Date(); if (which === 'tomorrow') target.setDate(target.getDate() + 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'], out = [];
  for (const block of txt.split('BEGIN:VEVENT').slice(1)){
    const f = k => { const m = block.match(new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, 'm')); return m ? m[1].trim() : ''; };
    const st = icsDate(f('DTSTART')); if (!st) continue;
    let hit = same(st.d, target);
    const rr = f('RRULE');
    if (!hit && rr && st.d <= target){
      const rule = Object.fromEntries(rr.split(';').map(x => x.split('=')));
      const until = rule.UNTIL && icsDate(rule.UNTIL), interval = +(rule.INTERVAL || 1), diffDays = Math.floor((target - new Date(st.d.getFullYear(), st.d.getMonth(), st.d.getDate()))/864e5);
      const ok = !until || until.d >= new Date(target.getFullYear(), target.getMonth(), target.getDate());
      const byday = rule.BYDAY ? rule.BYDAY.split(',').map(x => x.slice(-2)) : [DAYS[st.d.getDay()]];
      const counted = !rule.COUNT || diffDays < +rule.COUNT*(rule.FREQ === 'WEEKLY' ? 7*interval : interval);
      if (ok && counted && rule.FREQ === 'DAILY') hit = diffDays % interval === 0;
      if (ok && counted && rule.FREQ === 'WEEKLY') hit = byday.includes(DAYS[target.getDay()]) && Math.floor(diffDays/7) % interval === 0;
    }
    if (hit && !f('EXDATE').includes(`${target.getFullYear()}${String(target.getMonth()+1).padStart(2,'0')}${String(target.getDate()).padStart(2,'0')}`))
      out.push({ time: st.allDay ? 'all day' : st.d.toTimeString().slice(0, 5), title: f('SUMMARY').replace(/\\([,;n])/g, '$1'), where: f('LOCATION').replace(/\\([,;n])/g, '$1') || undefined });
  }
  return { day: which, events: out.sort((a, b) => a.time.localeCompare(b.time)) };
}

function walk(roots, query, limit){
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean), hits = [];
  let seen = 0;
  const go = (d, depth) => {
    if (hits.length >= limit || seen > 40000 || depth > 7) return;
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list){
      seen++;
      if (/^(\.|node_modules$|\$|AppData$)/.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (words.every(w => e.name.toLowerCase().includes(w))){
        let st = null; try { st = fs.statSync(p); } catch (err) {}
        hits.push({ path: p, folder: e.isDirectory(), kb: st && !e.isDirectory() ? Math.round(st.size/1024) : undefined, modified: st ? st.mtime.toISOString().slice(0, 16) : undefined });
        if (hits.length >= limit) return;
      }
      if (e.isDirectory()) go(p, depth + 1);
    }
  };
  for (const r of roots) go(r, 0);
  return hits;
}

let screenUntil = 0, cameraOK = false;
const TOOLS = [
  { name: 'open_app', risk: 'safe', description: 'Open an installed app by name (anything in the Start menu, e.g. "Spotify", "Visual Studio Code", "Calculator").',
    parameters: obj({ name: S('App name') }, ['name']),
    async run({ name }){ const a = await pc.findApp(name); if (!a) return { error: 'not_found', name }; pc.launchApp(a.AppID); return { opened: a.Name }; } },
  { name: 'open_url', risk: 'safe', description: 'Open a web page in the default browser. For a web search use https://www.google.com/search?q=...',
    parameters: obj({ url: S('http or https URL') }, ['url']),
    async run({ url }){ if (!/^https?:\/\//i.test(url)) return { error: 'only_http_urls' }; await shell.openExternal(url); return { opened: url }; } },
  { name: 'open_path', risk: 'safe', description: 'Open a file or folder with its default app. Programs and scripts ask the user first.',
    parameters: obj({ path: S('Full path; ~ means the home folder') }, ['path']),
    async run({ path: p }, ctx){
      p = expand(p);
      if (!fs.existsSync(p)) return { error: 'not_found', path: p };
      if (EXEC.test(p) && !(await ctx.ask('Run a program?', `Atlas wants to open:\n${p}\n\nThis can run code on your PC.`))) return { declined: true };
      const err = await shell.openPath(p); return err ? { error: err } : { opened: p };
    } },
  { name: 'find_files', risk: 'safe', description: 'Find files or folders by name in the user\'s Desktop, Documents, Downloads, Pictures, Music, Videos and OneDrive.',
    parameters: obj({ query: S('Words that must all appear in the name'), folder: S('Optional folder to search instead'), limit: N('Max results, default 15') }, ['query']),
    async run({ query, folder, limit }){ const roots = folder ? [expand(folder)] : pc.userFolders(); return { results: walk(roots, query, Math.min(+limit || 15, 50)) }; } },
  { name: 'read_file', risk: 'safe', description: 'Read a text file (first 20 KB). Files outside the user\'s own folders ask first.',
    parameters: obj({ path: S('Full path') }, ['path']),
    async run({ path: p }, ctx){
      p = expand(p);
      if ((!inLibrary(p) || SENSITIVE.test(p)) && !(await ctx.ask('Read a file?', `Atlas wants to read this file and send its text to Gemini:\n${p}`))) return { declined: true };
      const buf = fs.readFileSync(p).subarray(0, 20480);
      if (buf.includes(0)) return { error: 'not_a_text_file' };
      return { path: p, text: buf.toString('utf8') };
    } },
  { name: 'write_file', risk: 'ask', description: 'Create or change a text file (notes, lists, drafts). Always asks the user first.',
    parameters: obj({ path: S('Full path'), content: S('Text to write'), append: { type: 'BOOLEAN', description: 'Add to the end instead of replacing' } }, ['path', 'content']),
    async run({ path: p, content, append }, ctx){
      p = expand(p);
      const exists = fs.existsSync(p);
      const what = append ? 'add to' : exists ? 'REPLACE the contents of' : 'create';
      if (!(await ctx.ask('Write a file?', `Atlas wants to ${what}:\n${p}\n\n${short(content, 500)}`))) return { declined: true };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      append ? fs.appendFileSync(p, content) : fs.writeFileSync(p, content);
      return { written: p };
    } },
  { name: 'move_to_recycle_bin', risk: 'ask', description: 'Move a file or folder to the Recycle Bin (it can be restored from there). Always asks first.',
    parameters: obj({ path: S('Full path') }, ['path']),
    async run({ path: p }, ctx){
      p = expand(p);
      if (!fs.existsSync(p)) return { error: 'not_found' };
      if (!(await ctx.ask('Move to Recycle Bin?', `Atlas wants to move this to the Recycle Bin:\n${p}`))) return { declined: true };
      await shell.trashItem(p); return { recycled: p };
    } },
  { name: 'clipboard', risk: 'safe', description: 'Read the clipboard text, or put text on the clipboard.',
    parameters: obj({ action: S('read or write', { enum: ['read', 'write'] }), text: S('Text to copy when writing') }, ['action']),
    async run({ action, text }){ if (action === 'write'){ clipboard.writeText(String(text || '')); return { copied: true }; } return { text: short(clipboard.readText(), 8000) }; } },
  { name: 'media', risk: 'safe', description: 'Control music and sound: play_pause, next, previous, mute, volume_up, volume_down, or set_volume with a percent.',
    parameters: obj({ action: S('Action', { enum: ['play_pause', 'next', 'previous', 'stop', 'mute', 'volume_up', 'volume_down', 'set_volume'] }), percent: N('For set_volume, 0-100') }, ['action']),
    async run({ action, percent }){
      if (action === 'set_volume'){ await pc.setVolume(+percent || 0); return { volume: +percent || 0 }; }
      if (!pc.KEYS[action]) return { error: 'unknown_action' };
      await pc.sendKeys(pc.KEYS[action], /volume/.test(action) ? 5 : 1); return { done: action };
    } },
  { name: 'system_status', risk: 'safe', description: 'Local date and time, battery, memory, CPU load, uptime and screen size.',
    parameters: obj({}),
    async run(){
      const c0 = os.cpus(); await new Promise(r => setTimeout(r, 300)); const c1 = os.cpus();
      let idle = 0, total = 0; c1.forEach((c, i) => { for (const k in c.times){ const d = c.times[k] - c0[i].times[k]; total += d; if (k === 'idle') idle += d; } });
      const bat = await pc.ps('$b = Get-CimInstance Win32_Battery; if ($b) { "$($b.EstimatedChargeRemaining);$($b.BatteryStatus)" }');
      const [pct, st] = bat.out.split(';');
      const d = screen.getPrimaryDisplay();
      return { now: new Date().toString(), battery: pct ? { percent: +pct, charging: st === '2' } : 'no battery', cpu_percent: Math.round(100*(1 - idle/total)),
        memory_gb: { used: +((os.totalmem() - os.freemem())/1e9).toFixed(1), total: +(os.totalmem()/1e9).toFixed(1) }, uptime_hours: +(os.uptime()/3600).toFixed(1), screen: `${d.size.width}x${d.size.height}` };
    } },
  { name: 'look_at_screen', risk: 'ask', description: 'Take a screenshot and answer a question about what is on the user\'s screen. Only when the user asks you to look at their screen.',
    parameters: obj({ question: S('What to find out from the screen') }, ['question']),
    async run({ question }, ctx){
      if (Date.now() > screenUntil){
        const r = await ctx.ask('Look at your screen?', 'Atlas wants to take a screenshot and send it to Gemini to answer:\n' + question, ['Allow once', 'Allow for 10 minutes', 'Deny']);
        if (!r) return { declined: true };
        if (r === 2) screenUntil = Date.now() + 600000;
      }
      const d = screen.getPrimaryDisplay(), scale = Math.min(1, 1600/d.size.width);
      ctx.hide(true);
      await new Promise(r => setTimeout(r, 150));
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width*scale), height: Math.round(d.size.height*scale) } });
      ctx.hide(false);
      if (!src) return { error: 'no_screen' };
      const jpg = src.thumbnail.toJPEG(70).toString('base64');
      const answer = await ctx.generate([{ inlineData: { mimeType: 'image/jpeg', data: jpg } }, { text: `This is the user's screen. ${question}\nAnswer in a few plain sentences.` }]);
      return { answer };
    } },
  { name: 'look_at_camera', risk: 'ask', description: 'Look at the user through the webcam and answer a question about what you see (what they are holding, how they look, what is behind them). Only when the user asks you to look at them or at something they show you.',
    parameters: obj({ question: S('What to find out from the camera') }, ['question']),
    async run({ question }, ctx){
      if (!cameraOK){
        const r = await ctx.ask('Look through your camera?', 'Atlas wants to send one camera photo to Gemini to answer:\n' + question, ['Allow once', 'Allow until Atlas closes', 'Deny']);
        if (!r) return { declined: true };
        if (r === 2) cameraOK = true;
      }
      const jpg = await ctx.frame();
      if (!jpg) return { error: 'camera_off', hint: 'The camera is not on. Ask the user to wake Atlas with the camera allowed.' };
      const answer = await ctx.generate([{ inlineData: { mimeType: 'image/jpeg', data: jpg } }, { text: `This is a photo of the user from their webcam. ${question}\nAnswer in a few plain sentences, speaking to the user.` }]);
      return { answer };
    } },
  { name: 'set_wallpaper', risk: 'ask', description: 'Set the desktop wallpaper to an image file. Asks first.',
    parameters: obj({ path: S('Full path to a .jpg/.png/.bmp') }, ['path']),
    async run({ path: p }, ctx){
      p = expand(p);
      if (!fs.existsSync(p)) return { error: 'not_found' };
      if (!(await ctx.ask('Change wallpaper?', `Atlas wants to set your wallpaper to:\n${p}`))) return { declined: true };
      await pc.setWallpaper(p); ctx.wallpaperChanged(); return { wallpaper: p };
    } },
  { name: 'set_theme', risk: 'ask', description: 'Switch Windows between dark and light mode. Asks first.',
    parameters: obj({ mode: S('dark or light', { enum: ['dark', 'light'] }) }, ['mode']),
    async run({ mode }, ctx){ if (!(await ctx.ask('Change theme?', `Atlas wants to switch Windows to ${mode} mode.`))) return { declined: true }; await pc.setTheme(mode); return { theme: mode }; } },
  { name: 'run_powershell', risk: 'ask', description: 'Run a PowerShell command when no other tool fits (e.g. list running programs, check disk space, network info). The user sees the exact command and must approve it. Prefer read-only commands.',
    parameters: obj({ command: S('The PowerShell command'), reason: S('One line on why, shown to the user') }, ['command', 'reason']),
    async run({ command, reason }, ctx){
      if (!(await ctx.ask('Run a PowerShell command?', `${reason}\n\n${command}`))) return { declined: true };
      const r = await pc.ps(command, 30000);
      return { exit: r.code, output: short(r.out, 4000), errors: short(r.err, 1000) || undefined, timed_out: r.timedOut || undefined };
    } },
  { name: 'set_reminder', risk: 'safe', description: 'Remind the user later: a notification plus Atlas saying it out loud.',
    parameters: obj({ text: S('What to remind about'), minutes: N('Minutes from now'), at: S('Or a local time like 2026-10-25T18:30') }, ['text']),
    async run({ text, minutes, at }){
      const t = at ? new Date(at).getTime() : Date.now() + (+minutes || 10)*60000;
      if (!isFinite(t)) return { error: 'bad_time' };
      brain.addReminder(t, text); return { set_for: new Date(t).toString() };
    } },
  { name: 'get_weather', risk: 'safe', description: 'Current weather and the forecast for today and tomorrow. Uses the user\'s home city from memory if no city is given.',
    parameters: obj({ city: S('Optional city') }), run: ({ city }) => weather(city) },
  { name: 'get_calendar', risk: 'safe', description: 'The user\'s calendar events for today or tomorrow.',
    parameters: obj({ day: S('today or tomorrow', { enum: ['today', 'tomorrow'] }) }), run: ({ day }) => calendar(day) },
  { name: 'remember', risk: 'safe', description: 'Save a durable fact about the user to long-term memory. Use it on your own whenever you learn something lasting (name, home city, preferences, people, projects, routines, goals, important dates). For profile facts use "Key: value", e.g. "Home city: Pune".',
    parameters: obj({ category: S('Kind of fact', { enum: ['profile', 'preference', 'person', 'project', 'routine', 'other'] }), fact: S('The fact, short and specific') }, ['category', 'fact']),
    async run({ category, fact }, ctx){ const r = brain.remember(category, fact); ctx.memoryChanged(); return r; } },
  { name: 'recall', risk: 'safe', description: 'Search long-term memory and everything from past days (conversations, notes, day and week summaries, apps and windows used) by meaning. Use it whenever the user refers to something from before this conversation.',
    parameters: obj({ query: S('What to look for, in plain words') }, ['query']), async run({ query }, ctx){ return { found: await brain.recall(query, ctx && ctx.embed) }; } },
  { name: 'forget', risk: 'ask', description: 'Remove facts from long-term memory when the user asks. Shows the user what will be removed first.',
    parameters: obj({ query: S('Words that identify the facts') }, ['query']),
    async run({ query }, ctx){
      const hits = brain.forgetCandidates(query);
      if (!hits.length) return { found: 0 };
      if (!(await ctx.ask('Forget this?', 'Atlas will remove from memory:\n\n' + hits.map(h => '• ' + h).join('\n')))) return { declined: true };
      const gone = brain.forget(query); ctx.memoryChanged(); return { forgot: gone };
    } },
  { name: 'think_deeply', risk: 'safe', description: 'For hard or long tasks: research, comparisons, planning, writing, analysing documents, or multi-step work on the PC. A stronger reasoning model works on it in the background with web search, web pages, memory and the PC tools, saves a full note and reports back. Not for quick questions you can answer yourself.',
    parameters: obj({ task: S('The complete task with all the context from the conversation, written so it can be done without asking anything') }, ['task']),
    async run({ task }, ctx){ return ctx.think ? ctx.think(task) : { error: 'unavailable' }; } }
];

const declarations = () => TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
async function run(name, args, ctx){
  const t = TOOLS.find(x => x.name === name);
  if (!t) return { error: 'unknown_tool' };
  return t.run(args || {}, ctx);
}
const label = name => ({ open_app: 'opening', open_url: 'opening', open_path: 'opening', find_files: 'searching', read_file: 'reading', write_file: 'writing',
  look_at_screen: 'looking', look_at_camera: 'looking', think_deeply: 'thinking deeply', get_weather: 'checking weather', get_calendar: 'checking calendar', recall: 'remembering', remember: 'remembering' })[name] || 'working';

module.exports = { declarations, run, label, weather, calendar };
