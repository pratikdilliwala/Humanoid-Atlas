// Calls to Gemini and ElevenLabs from the main process, so keys never reach the page.
// The web build's own API routes (api/chat.js, api/speak.js) are reused as-is for the non-live fallback.
const path = require('path');
const { app } = require('electron');
const store = require('./store');

const WEB = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// a public ElevenLabs premade voice ("Brian", deep narration) that any account can use; people can pick their own in Settings
const PUBLIC_VOICE = 'nPczCjzI2devNBz1zQrb';

// run a Vercel-style handler with a minimal req/res; everything comes from this user's own settings, never the web build's defaults
function route(name, body){
  process.env.GEMINI_API_KEY = store.getKey('gemini');
  process.env.ELEVENLABS_API_KEY = store.getKey('eleven');
  process.env.ELEVENLABS_VOICE_ID = store.get('elevenVoice') || PUBLIC_VOICE;
  const handler = require(path.join(WEB, 'api', name + '.js'));
  return new Promise(resolve => {
    const res = { code: 200, status(c){ this.code = c; return this; }, setHeader(){},
      json(o){ resolve({ status: this.code, json: o }); }, send(b){ resolve({ status: this.code, body: b }); } };
    Promise.resolve(handler({ method: 'POST', headers: { 'x-forwarded-for': 'desktop' }, body }, res))
      .catch(e => resolve({ status: 500, json: { error: e.message } }));
  });
}

// newest version first; "preview" loses a tie against a stable release
const version = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
let modelsP = null;
function listModels(){
  if (!modelsP) modelsP = (async () => {
    const out = [];
    let page = '';
    do {
      const r = await fetch(`${BASE}/models?pageSize=200${page ? '&pageToken=' + page : ''}`, { headers: { 'x-goog-api-key': store.getKey('gemini') } });
      if (!r.ok) throw new Error('models ' + r.status);
      const data = await r.json();
      out.push(...(data.models || []));
      page = data.nextPageToken || '';
    } while (page);
    return out;
  })().catch(e => { modelsP = null; throw e; });
  return modelsP;
}
async function liveModels(){
  const pinned = store.get('liveModel');
  if (pinned) return [pinned];
  const ms = (await listModels()).filter(m => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'));
  const score = n => version(n)*10 + (/native-audio/.test(n) ? 2 : 0) + (/preview|exp/.test(n) ? 0 : 1);
  return ms.map(m => m.name.replace(/^models\//, '')).sort((a, b) => score(b) - score(a));
}
async function textModels(){
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const ms = (await listModels()).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && /flash/.test(n) && !/live|tts|image|audio|embedding|robotics|computer|exp/.test(n));
    const score = n => version(n)*10 + (/lite/.test(n) ? 0 : 1) + (/preview/.test(n) ? 0 : 0.5);
    return ms.sort((a, b) => score(b) - score(a)).slice(0, 4);
  } catch (e) { return ['gemini-flash-latest', 'gemini-flash-lite-latest']; }
}

// the strongest reasoning models first (pro), then the best flash models as fallback
async function reasoningModels(){
  try {
    const ms = (await listModels()).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && /pro|flash/.test(n) && !/live|tts|image|audio|embedding|robotics|computer|exp|lite/.test(n));
    const score = n => version(n)*10 + (/pro/.test(n) ? 5 : 0) + (/preview/.test(n) ? 0 : 0.5);
    return ms.sort((a, b) => score(b) - score(a)).slice(0, 4);
  } catch (e) { return ['gemini-pro-latest', 'gemini-flash-latest']; }
}

// one generateContent call on one model; returns { ok, status, candidate } so callers can keep whole model turns
async function request(model, payload){
  const key = store.getKey('gemini');
  if (!key) throw new Error('missing_key');
  const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, candidate: data.candidates && data.candidates[0], error: data.error && data.error.message };
}
const textOf = c => ((c && c.content && c.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();

// one-shot generateContent with model fallover; parts are Gemini parts ({text} or {inlineData})
async function generate(parts, { json = false, system = '', tools } = {}){
  const payload = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.4, maxOutputTokens: 4096, ...(json ? { responseMimeType: 'application/json' } : {}) } };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  if (tools) payload.tools = tools;
  let last = '';
  for (const model of await textModels()){
    try {
      const r = await request(model, payload);
      if (!r.ok){ last = `${model}: ${r.status}`; continue; }
      const text = textOf(r.candidate);
      if (!text){ last = `${model}: empty`; continue; }
      if (tools) return { text, sources: ((r.candidate.groundingMetadata && r.candidate.groundingMetadata.groundingChunks) || []).map(g => g.web && g.web.uri).filter(Boolean).slice(0, 8) };
      return json ? JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) : text;
    } catch (e) { if (e.message === 'missing_key') throw e; last = `${model}: ${e.message}`; }
  }
  throw new Error(last || 'no_model');
}

// text embeddings for semantic memory; null when no embedding model is available
let embedModelP = null;
async function embed(texts){
  if (!embedModelP) embedModelP = listModels().then(ms => {
    const e = ms.filter(m => (m.supportedGenerationMethods || []).includes('embedContent')).map(m => m.name.replace(/^models\//, ''));
    return e.filter(n => /gemini-embedding/.test(n)).sort((a, b) => version(b) - version(a) || b.localeCompare(a))[0] || e[0] || null;
  }).catch(() => { embedModelP = null; return null; });
  const model = await embedModelP;
  if (!model) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += 100){
    const batch = texts.slice(i, i + 100);
    const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': store.getKey('gemini') },
      body: JSON.stringify({ requests: batch.map(t => ({ model: 'models/' + model, content: { parts: [{ text: t.slice(0, 6000) }] }, outputDimensionality: 768 })) }) });
    if (!r.ok) throw new Error('embed ' + r.status);
    const data = await r.json();
    out.push(...(data.embeddings || []).map(e => e.values));
  }
  return out;
}

module.exports = { route, liveModels, reasoningModels, request, textOf, generate, embed, BASE };
