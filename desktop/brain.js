// Atlas's own brain, kept as plain files in AppData\Atlas\brain:
//   memory.md        what he knows about you (you can edit it; it is re-read at the start of every conversation)
//   journal/DAY.jsonl what happened each day: what you said, what he said, what he did, which window you were in
//   days/DAY.md      a digest of each finished day, written by Gemini from the journal
//   habits.json      routines learned from the journal (which apps you open around which time)
//   state.json       bookkeeping (last briefing, what was already learned or suggested)
const fs = require('fs'), path = require('path');
const { app } = require('electron');

const dir = (...p) => path.join(app.getPath('userData'), 'brain', ...p);
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

/* ---------- memory.md ---------- */
const SECTIONS = ['Profile', 'Preferences', 'People', 'Projects', 'Routines', 'Other'];
const CAT = { profile: 'Profile', preference: 'Preferences', person: 'People', project: 'Projects', routine: 'Routines', other: 'Other' };
const HEAD = '# Atlas memory\n\nEverything Atlas knows about you. Edit freely: he re-reads this file at the start of every conversation.\n';

function readMemory(){
  const mem = { profile: {}, sections: Object.fromEntries(SECTIONS.slice(1).map(s => [s, []])) };
  let txt = '';
  try { txt = fs.readFileSync(dir('memory.md'), 'utf8'); } catch (e) { return mem; }
  let cur = null;
  for (const line of txt.split(/\r?\n/)){
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h){ cur = SECTIONS.find(s => s.toLowerCase() === h[1].toLowerCase()) || 'Other'; continue; }
    const b = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!b || !cur) continue;
    if (cur === 'Profile'){ const kv = b[1].match(/^([^:]{1,30}):\s*(.+)$/); if (kv) mem.profile[kv[1].trim()] = kv[2].trim(); else mem.sections.Other.push(b[1]); }
    else mem.sections[cur].push(b[1]);
  }
  return mem;
}
function writeMemory(mem){
  let out = HEAD + '\n## Profile\n' + Object.entries(mem.profile).map(([k, v]) => `- ${k}: ${v}\n`).join('');
  for (const s of SECTIONS.slice(1)) out += `\n## ${s}\n` + mem.sections[s].map(x => `- ${x}\n`).join('');
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(dir('memory.md'), out);
}
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function remember(category, text){
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'empty' };
  const mem = readMemory(), sec = CAT[String(category || '').toLowerCase()] || 'Other';
  if (sec === 'Profile'){
    const kv = text.match(/^([^:]{1,30}):\s*(.+)$/);
    if (kv){ mem.profile[kv[1].trim()] = kv[2].trim(); writeMemory(mem); return { ok: true, saved: text }; }
  }
  const list = mem.sections[sec === 'Profile' ? 'Other' : sec], n = norm(text);
  const dup = list.findIndex(x => norm(x) === n || norm(x).includes(n));
  if (dup >= 0) return { ok: true, already: list[dup] };
  // a newer, longer version of an old fact replaces it
  const older = list.findIndex(x => n.includes(norm(x)));
  if (older >= 0) list[older] = text; else list.push(text);
  writeMemory(mem);
  return { ok: true, saved: text };
}
function setProfile(key, value){ const mem = readMemory(); mem.profile[key] = value; writeMemory(mem); }
function matches(text, query){ const words = norm(query).split(' ').filter(Boolean); const t = norm(text); return words.length > 0 && words.every(w => t.includes(w)); }
function forgetCandidates(query){
  const mem = readMemory(), hits = [];
  for (const [k, v] of Object.entries(mem.profile)) if (matches(`${k} ${v}`, query)) hits.push(`${k}: ${v}`);
  for (const s of SECTIONS.slice(1)) for (const x of mem.sections[s]) if (matches(x, query)) hits.push(x);
  return hits;
}
function forget(query){
  const mem = readMemory(), gone = [];
  for (const [k, v] of Object.entries(mem.profile)) if (matches(`${k} ${v}`, query)){ gone.push(`${k}: ${v}`); delete mem.profile[k]; }
  for (const s of SECTIONS.slice(1)) mem.sections[s] = mem.sections[s].filter(x => matches(x, query) ? (gone.push(x), false) : true);
  writeMemory(mem);
  return gone;
}
function memoryText(){
  const mem = readMemory();
  let out = Object.entries(mem.profile).map(([k, v]) => `${k}: ${v}`).join('\n');
  for (const s of SECTIONS.slice(1)) if (mem.sections[s].length) out += `\n${s}:\n` + mem.sections[s].map(x => `- ${x}`).join('\n');
  return out.trim().slice(-8000);
}

/* ---------- journal ---------- */
function log(kind, data = {}){
  try {
    fs.mkdirSync(dir('journal'), { recursive: true });
    fs.appendFileSync(dir('journal', day() + '.jsonl'), JSON.stringify({ t: Date.now(), kind, ...data }) + '\n');
  } catch (e) {}
}
function readDay(d){
  try { return fs.readFileSync(dir('journal', d + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}
function journalDays(){ try { return fs.readdirSync(dir('journal')).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, 10)).sort(); } catch (e) { return []; } }

// time spent per app and per window title, from focus changes (each lasts until the next change, idle or stop)
function usage(entries){
  const apps = {}, titles = {}, firstSeen = {};
  const marks = entries.filter(e => e.kind === 'focus' || e.kind === 'idle' || e.kind === 'stop');
  for (let i = 0; i < marks.length; i++){
    const e = marks[i];
    if (e.kind !== 'focus' || !e.app) continue;
    if (!(e.app in firstSeen)) firstSeen[e.app] = e.t;
    const next = marks[i+1] ? marks[i+1].t : Math.min(Date.now(), e.t + 60000);
    const ms = Math.max(0, Math.min(next - e.t, 3*3600e3));
    apps[e.app] = (apps[e.app] || 0) + ms;
    if (e.title) titles[e.title] = (titles[e.title] || 0) + ms;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v/60000)]).filter(x => x[1] > 0);
  return { apps: top(apps, 10), titles: top(titles, 12), firstSeen };
}
function conversation(entries, max = 8000){
  return entries.filter(e => e.kind === 'heard' || e.kind === 'said' || e.kind === 'action')
    .map(e => e.kind === 'action' ? `[Atlas did: ${e.tool} ${e.ok ? 'ok' : 'failed'}]` : `${e.kind === 'heard' ? 'User' : 'Atlas'}: ${e.text}`)
    .join('\n').slice(-max);
}
function recall(query){
  const out = [];
  for (const x of forgetCandidates(query)) out.push('memory: ' + x);
  const days = journalDays().slice(-30).reverse();
  for (const d of days){
    let dg = ''; try { dg = fs.readFileSync(dir('days', d + '.md'), 'utf8'); } catch (e) {}
    if (dg && matches(dg, query)) out.push(`${d} digest: ` + dg.replace(/\s+/g, ' ').slice(0, 400));
    for (const e of readDay(d)){
      const txt = e.text || e.title || '';
      if (txt && matches(txt, query)) out.push(`${d} ${new Date(e.t).toTimeString().slice(0, 5)} ${e.kind}: ${txt.slice(0, 200)}`);
      if (out.length > 25) return out;
    }
  }
  return out;
}

/* ---------- state, digests, learning ---------- */
const state = () => readJSON(dir('state.json'), {});
const saveState = s => writeJSON(dir('state.json'), s);
function lastDigest(){
  const d = journalDays().filter(x => x < day()).pop();
  if (!d) return '';
  // just the summary paragraph, above the per-app tables
  try { return d + ': ' + fs.readFileSync(dir('days', d + '.md'), 'utf8').split('\n## ')[0].split('\n').filter(l => l && !l.startsWith('#')).join(' '); } catch (e) { return ''; }
}

const LEARN_SYS = 'You maintain the long-term memory of Atlas, a personal desktop assistant. From the journal you are given, extract only durable, useful facts about the user ' +
  '(preferences, people and relationships, projects, routines, goals, important dates, how they like things done). Skip one-off chatter, anything already in the existing memory, ' +
  'and secrets such as passwords, card numbers or keys. Reply as JSON: {"summary": "2-4 sentences, in second person, about what the user worked on and talked about", ' +
  '"facts": [{"category": "preference|person|project|routine|other", "text": "short fact"}]}';

// digest finished days that have no digest yet, then learn facts from today's new conversation
async function learn(generate){
  const s = state(), today = day();
  for (const d of journalDays().filter(x => x < today).slice(-7)){
    if (fs.existsSync(dir('days', d + '.md'))) continue;
    const entries = readDay(d), u = usage(entries), convo = conversation(entries);
    let summary = '', facts = [];
    if (convo || u.apps.length){
      try {
        const r = await generate([{ text: `Existing memory:\n${memoryText() || '(empty)'}\n\nJournal for ${d}.\nTime per app (minutes): ${JSON.stringify(u.apps)}\nTop windows (minutes): ${JSON.stringify(u.titles)}\nConversation:\n${convo || '(none)'}` }], { json: true, system: LEARN_SYS });
        summary = String(r.summary || ''); facts = Array.isArray(r.facts) ? r.facts : [];
      } catch (e) { continue; } // Gemini unreachable: leave the day undigested and try again on the next pass
    }
    for (const f of facts) remember(f.category, f.text);
    const md = `# ${d}\n\n${summary || 'A quiet day.'}\n\n## Time per app\n` + u.apps.map(([a, m]) => `- ${a}: ${m} min\n`).join('') +
      `\n## Windows\n` + u.titles.map(([t, m]) => `- ${t} (${m} min)\n`).join('');
    fs.mkdirSync(dir('days'), { recursive: true });
    fs.writeFileSync(dir('days', d + '.md'), md);
  }
  // today so far: only the conversation since the last pass
  const since = s.learnedUpTo || 0;
  const fresh = readDay(today).filter(e => e.t > since);
  const convo = conversation(fresh);
  if (convo.split('\n').length >= 6){
    try {
      const r = await generate([{ text: `Existing memory:\n${memoryText() || '(empty)'}\n\nNew conversation from today:\n${convo}` }], { json: true, system: LEARN_SYS });
      for (const f of (Array.isArray(r.facts) ? r.facts : [])) remember(f.category, f.text);
      const s2 = state(); s2.learnedUpTo = Date.now(); saveState(s2);
    } catch (e) {}
  }
  computeHabits();
}

// an app is a habit when you first opened it on at least 3 of the last 14 days at a similar time of day
function computeHabits(){
  const days = journalDays().slice(-14), first = {};
  for (const d of days){
    const fs0 = usage(readDay(d)).firstSeen;
    for (const [a, t] of Object.entries(fs0)){
      const dt = new Date(t), min = dt.getHours()*60 + dt.getMinutes();
      if (min < 240) continue;
      (first[a] = first[a] || []).push(min);
    }
  }
  const habits = [];
  for (const [a, mins] of Object.entries(first)){
    if (mins.length < 3) continue;
    const sorted = [...mins].sort((x, y) => x - y), med = sorted[Math.floor(sorted.length/2)];
    const near = mins.filter(m => Math.abs(m - med) <= 45);
    if (near.length >= 3) habits.push({ app: a, minute: Math.round(near.reduce((x, y) => x + y, 0)/near.length), days: near.length });
  }
  writeJSON(dir('habits.json'), habits);
  return habits;
}
const habits = () => readJSON(dir('habits.json'), []);
const hhmm = m => `${Math.floor(m/60)}:${String(m%60).padStart(2, '0')}`;
function habitText(){ return habits().map(h => `- Usually opens ${h.app} around ${hhmm(h.minute)} (${h.days} of the last 14 days)`).join('\n'); }

// habits due now that haven't happened today and weren't offered today
function dueHabits(){
  const now = new Date(), min = now.getHours()*60 + now.getMinutes(), today = day();
  const seen = usage(readDay(today)).firstSeen, s = state();
  const offered = (s.offered && s.offered[today]) || [];
  return habits().filter(h => min >= h.minute - 10 && min <= h.minute + 30 && !(h.app in seen) && !offered.includes(h.app));
}
function markOffered(a){ const s = state(), today = day(); s.offered = { [today]: [...((s.offered && s.offered[today]) || []), a] }; saveState(s); }

/* ---------- reminders ---------- */
const reminders = () => readJSON(dir('reminders.json'), []);
function addReminder(at, text){ const r = reminders(); r.push({ at, text }); writeJSON(dir('reminders.json'), r); }
function takeDueReminders(){
  const r = reminders(), now = Date.now(), due = r.filter(x => x.at <= now);
  if (due.length) writeJSON(dir('reminders.json'), r.filter(x => x.at > now));
  return due;
}

module.exports = { dir, day, remember, setProfile, forget, forgetCandidates, readMemory, memoryText, log, readDay, usage, recall,
  state, saveState, lastDigest, learn, habitText, dueHabits, markOffered, hhmm, addReminder, reminders, takeDueReminders };
