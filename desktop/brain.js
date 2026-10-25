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
/* ---------- semantic index: brain/index.jsonl, one embedded snippet per line ---------- */
const readIndex = () => { try { return fs.readFileSync(dir('index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } };
const unit = v => { let s = 0; for (const x of v) s += x*x; s = Math.sqrt(s) || 1; return Float32Array.from(v, x => x/s); };
const toB64 = v => Buffer.from(unit(v).buffer).toString('base64');
const fromB64 = s => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
async function addToIndex(items, embed){
  const have = new Set(readIndex().map(x => x.id));
  const todo = items.filter(i => i.text && i.text.trim() && !have.has(i.id));
  if (!todo.length || !embed) return 0;
  const vecs = await embed(todo.map(i => i.text));
  if (!vecs || vecs.length !== todo.length) return 0;
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(dir('index.jsonl'), todo.map((i, k) => JSON.stringify({ id: i.id, kind: i.kind, day: i.day || '', text: i.text.slice(0, 2000), vec: toB64(vecs[k]) })).join('\n') + '\n');
  return todo.length;
}
// everything worth finding later: memory facts, conversation exchanges, day and week summaries, deep-thinking notes
function indexItems(){
  const items = [], mem = readMemory();
  for (const [k, v] of Object.entries(mem.profile)) items.push({ id: 'fact:' + norm(`${k} ${v}`), kind: 'memory', text: `${k}: ${v}` });
  for (const s of SECTIONS.slice(1)) for (const x of mem.sections[s]) items.push({ id: 'fact:' + norm(x), kind: 'memory', text: x });
  for (const d of journalDays().slice(-30)){
    const e = readDay(d);
    for (let i = 0; i < e.length; i++){
      if (e[i].kind !== 'heard') continue;
      const reply = e.slice(i + 1, i + 4).find(x => x.kind === 'said');
      items.push({ id: `chat:${e[i].t}`, kind: 'conversation', day: d, text: `User: ${e[i].text}${reply ? `\nAtlas: ${reply.text}` : ''}` });
    }
  }
  for (const sub of ['days', 'notes']){
    let files = []; try { files = fs.readdirSync(dir(sub)).filter(f => f.endsWith('.md')); } catch (e) {}
    for (const f of files){
      const kind = sub === 'notes' ? 'note' : /W\d\d\.md$/.test(f) ? 'week' : 'day';
      try { items.push({ id: `${kind}:${f}`, kind, day: f.slice(0, 10), text: fs.readFileSync(dir(sub, f), 'utf8').slice(0, 4000) }); } catch (e) {}
    }
  }
  return items;
}
async function recall(query, embed){
  const out = [];
  if (embed){
    try {
      const [q] = (await embed([query])) || [];
      if (q){
        const qv = unit(q), memNow = memoryText();
        const scored = readIndex()
          // a memory fact that was since edited or forgotten doesn't come back
          .filter(x => x.kind !== 'memory' || memNow.includes(x.text))
          .map(x => { const v = fromB64(x.vec); let s = 0; for (let i = 0; i < v.length && i < qv.length; i++) s += v[i]*qv[i]; return { x, s }; })
          .sort((a, b) => b.s - a.s).slice(0, 8).filter(o => o.s > 0.3);
        for (const { x } of scored) out.push(`${x.day ? x.day + ' ' : ''}${x.kind}: ${x.text.replace(/\s+/g, ' ').slice(0, 500)}`);
      }
    } catch (e) {}
  }
  for (const x of recallWords(query)) if (!out.some(o => o.includes(x.slice(x.indexOf(':') + 1).trim().slice(0, 60)))) out.push(x);
  return out.slice(0, 20);
}
function recallWords(query){
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

// ISO week label, e.g. 2026-W43
function week(d){
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())), n = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - n);
  const y = t.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((t - Date.UTC(y, 0, 1))/864e5 + 1)/7)).padStart(2, '0')}`;
}
function lastWeek(){
  let files = []; try { files = fs.readdirSync(dir('days')).filter(f => /W\d\d\.md$/.test(f)).sort(); } catch (e) {}
  const f = files.pop();
  if (!f) return '';
  try { return f.slice(0, -3) + ': ' + fs.readFileSync(dir('days', f), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).join(' ').slice(0, 1200); } catch (e) { return ''; }
}

const WEEK_SYS = 'You write the weekly review in the memory of Atlas, a personal desktop assistant. From the daily digests, write 4-6 sentences in second person: the main themes, ' +
  'what moved forward on each project, people who came up, patterns in how the user works, and anything left open to follow up. Plain text, no lists.';
const CONSOLIDATE_SYS = 'You tidy the long-term memory of Atlas, a personal desktop assistant. Merge duplicates, combine facts about the same thing, and drop a fact only when a newer one ' +
  'clearly replaces it. Keep everything else, keep facts short, never invent anything. Reply as JSON: {"profile": {"Key": "value"}, "Preferences": [], "People": [], "Projects": [], "Routines": [], "Other": []}';

// a weekly review for each finished week, then a tidy-up of memory.md (with a backup) once per new week
async function weekly(generate){
  let digests = []; try { digests = fs.readdirSync(dir('days')).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch (e) { return; }
  const thisWeek = week(new Date()), byWeek = {};
  for (const f of digests){ const w = week(new Date(f.slice(0, 10) + 'T12:00')); (byWeek[w] = byWeek[w] || []).push(f); }
  let wrote = false;
  for (const [w, files] of Object.entries(byWeek)){
    if (w === thisWeek || fs.existsSync(dir('days', w + '.md'))) continue;
    const text = files.map(f => fs.readFileSync(dir('days', f), 'utf8').split('\n## ')[0]).join('\n\n');
    try { fs.writeFileSync(dir('days', w + '.md'), `# Week ${w}\n\n${String(await generate([{ text }], { system: WEEK_SYS })).trim()}\n`); wrote = true; } catch (e) { return; }
  }
  if (!wrote) return;
  const mem = readMemory(), count = m => Object.keys(m.profile).length + SECTIONS.slice(1).reduce((n, s) => n + m.sections[s].length, 0);
  if (count(mem) < 8) return;
  try {
    const r = await generate([{ text: fs.readFileSync(dir('memory.md'), 'utf8') }], { json: true, system: CONSOLIDATE_SYS });
    const next = { profile: r.profile && typeof r.profile === 'object' ? r.profile : {}, sections: {} };
    for (const s of SECTIONS.slice(1)) next.sections[s] = Array.isArray(r[s]) ? r[s].map(String).filter(Boolean) : [];
    // a tidy-up that loses most of memory is a bad answer, not a tidy-up
    if (count(next) < count(mem)*0.6) return;
    fs.copyFileSync(dir('memory.md'), dir('memory.bak.md'));
    writeMemory(next);
  } catch (e) {}
}

// digest finished days that have no digest yet, learn facts from today's new conversation, review finished weeks, update the search index
async function learn(generate, embed){
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
  await weekly(generate);
  if (embed){ try { await addToIndex(indexItems(), embed); } catch (e) {} }
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

module.exports = { dir, day, week, remember, setProfile, forget, forgetCandidates, readMemory, memoryText, log, readDay, usage, recall, readIndex, addToIndex, indexItems,
  state, saveState, lastDigest, lastWeek, learn, habitText, dueHabits, markOffered, hhmm, addReminder, reminders, takeDueReminders };
