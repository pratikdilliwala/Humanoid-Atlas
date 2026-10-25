// Atlas's brain: forwards a short chat to Google's Gemini API. The key stays on the server.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.6-flash,gemini-3.1-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
const hits = new Map();
let day = '', dayCount = 0;

function limited(ip){
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (today !== day){ day = today; dayCount = 0; }
  if (++dayCount > 800) return true;
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 12;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use_post' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'missing_key' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon';
  if (limited(ip)) return res.status(429).json({ error: 'slow_down' });

  let body = req.body || {};
  if (typeof body === 'string'){ try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = String(body.text || '').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'empty' });
  const name = String(body.name || '').trim().slice(0, 40);
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8)
    .map(m => ({ role: m && m.role === 'model' ? 'model' : 'user', parts: [{ text: String((m && m.text) || '').slice(0, 600) }] }))
    .filter(m => m.parts[0].text);

  const system = 'You are Atlas, a calm, deep-voiced humanoid made of light, standing in a moonlit Himalayan valley inside a web page. ' +
    'You can see the user through their camera and you turn your head to follow them. You speak out loud, so answer in at most two short spoken sentences, ' +
    'with no markdown, lists, emoji or stage directions. Be confident, warm and a little cinematic. If the user writes in Hindi or Hinglish, reply the same way. ' +
    (name ? `The user's name is ${name}.` : '');
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [...history, { role: 'user', parts: [{ text }] }],
    // thinking tokens count against maxOutputTokens, so leave room for them; the prompt keeps the spoken reply short
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
  };

  let lastErr = '', limitedAll = true;
  for (const model of MODELS){
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok){
        lastErr = `${model}: ${r.status} ${(data.error && data.error.message) || ''}`.slice(0, 300);
        if (r.status === 400 && /API key/i.test(lastErr)) return res.status(401).json({ error: 'bad_key' });
        // each free-tier model has its own quota, so a 429 here is a reason to try the next one
        if (r.status !== 429) limitedAll = false;
        continue;
      }
      limitedAll = false;
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const reply = parts.filter(p => p.text && !p.thought).map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
      if (reply) return res.status(200).json({ reply, model });
      lastErr = `${model}: empty reply`;
    } catch (e) {
      lastErr = `${model}: ${e.message}`;
      limitedAll = false;
    }
  }
  if (limitedAll) return res.status(429).json({ error: 'slow_down' });
  console.error('Atlas brain failed:', lastErr);
  return res.status(502).json({ error: 'upstream', detail: lastErr });
};
