// Deep thinking: hard requests go to Gemini's strongest reasoning model, which can search the web, read pages,
// recall memory and use the PC tools over several steps. It runs in the background; the answer is saved as a note.
const fs = require('fs'), path = require('path');
const cloud = require('./cloud'), brain = require('./brain'), tools = require('./tools');

const MAX_STEPS = 12, MAX_MS = 180000;
const str = description => ({ type: 'STRING', description });
const EXTRA = [
  { name: 'web_search', description: 'Search the web with Google. Returns an answer and its source links.', parameters: { type: 'OBJECT', properties: { query: str('What to search for') }, required: ['query'] } },
  { name: 'read_webpage', description: 'Read the text of a web page (first 40 KB).', parameters: { type: 'OBJECT', properties: { url: str('http or https URL') }, required: ['url'] } }
];
const SYS = "You are the deep-thinking mind of Atlas, a personal assistant on the user's Windows PC. Work the task out properly: plan, then use tools " +
  '(web_search for anything current or factual, read_webpage for details from a page, recall for what you know about the user, PC tools when the task needs the PC), ' +
  'check your reasoning, then write the final answer. Never invent facts; link your sources. Some PC tools ask the user for permission: if they decline, carry on without it. ' +
  'The final answer is a markdown note: a first line "# <short title>", then "## Summary" with two or three plain sentences Atlas can say out loud, then the full details.';

function htmlToText(html){
  return html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
async function readPage(url){
  if (!/^https?:\/\//i.test(String(url))) return { error: 'only_http_urls' };
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Atlas' } });
    const type = r.headers.get('content-type') || '';
    if (!/text|html|json|xml/.test(type)) return { error: 'not_text', type };
    const body = await r.text();
    return { url: r.url, status: r.status, text: (/html/.test(type) ? htmlToText(body) : body).slice(0, 40000) };
  } finally { clearTimeout(to); }
}

async function callTool(c, ctx){
  if (c.name === 'web_search') return cloud.generate([{ text: String((c.args || {}).query || '') }], { tools: [{ googleSearch: {} }] });
  if (c.name === 'read_webpage') return readPage((c.args || {}).url);
  return tools.run(c.name, c.args, ctx);
}

// the agent loop; model turns are kept exactly as returned, so Gemini's thought signatures survive between steps
async function run(task, ctx, onStep = () => {}){
  const functionDeclarations = [...EXTRA, ...tools.declarations().filter(d => d.name !== 'think_deeply')];
  const contents = [{ role: 'user', parts: [{ text: `What you know about the user:\n${brain.memoryText() || '(nothing yet)'}\n\nIt is now ${new Date().toString()}.\n\nTask: ${task}` }] }];
  const models = await cloud.reasoningModels();
  const base = { systemInstruction: { parts: [{ text: SYS }] }, tools: [{ functionDeclarations }], generationConfig: { maxOutputTokens: 8192 } };
  let mi = 0;
  const t0 = Date.now();
  for (let step = 0; ; step++){
    const last = step >= MAX_STEPS || Date.now() - t0 > MAX_MS;
    if (last){
      const stop = { text: 'Stop using tools now and write the final note with what you have.' };
      const tail = contents[contents.length - 1];
      tail.role === 'user' ? tail.parts.push(stop) : contents.push({ role: 'user', parts: [stop] });
    }
    const payload = { ...base, contents, ...(last ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}) };
    let r = await cloud.request(models[mi], payload);
    // a model with no quota or no access: try the next one, but only before the conversation holds model turns
    while (!r.ok && step === 0 && mi + 1 < models.length && [403, 404, 429, 500, 503].includes(r.status)) r = await cloud.request(models[++mi], payload);
    if (!r.ok) throw new Error(`${models[mi]}: ${r.status} ${r.error || ''}`.trim());
    const content = r.candidate && r.candidate.content;
    if (!content) throw new Error('empty answer');
    contents.push(content);
    const calls = (content.parts || []).filter(p => p.functionCall).map(p => p.functionCall);
    if (!calls.length || last) return { text: cloud.textOf(r.candidate), model: models[mi], steps: step + 1 };
    const parts = [];
    for (const c of calls){
      onStep(c.name);
      let result;
      try { result = await callTool(c, ctx); } catch (e) { result = { error: e.message }; }
      parts.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { result } } });
    }
    contents.push({ role: 'user', parts });
  }
}

function summaryOf(text){
  const m = text.match(/##\s*Summary\s*\n([\s\S]*?)(\n##\s|$)/i);
  return (m ? m[1] : text.replace(/^#.*$/gm, '')).replace(/[*_`#>\[\]]/g, '').replace(/\(https?:[^)]+\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}
function save(task, text){
  const title = ((text.match(/^#\s+(.+)$/m) || [])[1] || task).trim().slice(0, 80);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'note';
  fs.mkdirSync(brain.dir('notes'), { recursive: true });
  let file = brain.dir('notes', `${brain.day()}-${slug}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = brain.dir('notes', `${brain.day()}-${slug}-${i}.md`);
  fs.writeFileSync(file, `${text}\n\n---\nAsked: ${task}\n`);
  brain.log('note', { title, file: path.basename(file) });
  return { file, title };
}

// one deep task at a time; returns at once so the voice never waits
let busy = '';
function start(task, ctx, { onStep = () => {}, onDone = () => {}, onError = () => {} } = {}){
  task = String(task || '').trim();
  if (!task) return { error: 'empty_task' };
  if (busy) return { error: 'busy', working_on: busy };
  busy = task;
  run(task, ctx, onStep)
    .then(r => { const n = save(task, r.text || 'No answer.'); onDone({ ...r, ...n, summary: summaryOf(r.text || '') }); })
    .catch(e => onError(e))
    .finally(() => { busy = ''; });
  return { started: true, note: 'Working in the background. Tell the user in one short sentence that you are on it and will tell them when it is done.' };
}

module.exports = { start, run, readPage, htmlToText, summaryOf, isBusy: () => !!busy };
