// Atlas's voice: turns a reply into speech with ElevenLabs. The key stays on the server.
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'TvCFCBsne35c1ohXselu';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const hits = new Map();

function limited(ip){
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 15;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use_post' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'missing_key' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon';
  if (limited(ip)) return res.status(429).json({ error: 'slow_down' });

  let body = req.body || {};
  if (typeof body === 'string'){ try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = String(body.text || '').trim().slice(0, 400);
  if (!text) return res.status(400).json({ error: 'empty' });

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
    });
    if (!r.ok){
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      console.error('Atlas voice failed:', r.status, detail);
      // bad key, used-up quota, a voice the plan can't use, or a missing voice won't fix themselves on retry
      const permanent = [401, 402, 403, 404].includes(r.status);
      return res.status([401, 402, 403, 429].includes(r.status) ? r.status : 502).json({ error: 'tts_failed', permanent, detail });
    }
    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (e) {
    console.error('Atlas voice error:', e.message);
    return res.status(502).json({ error: 'tts_failed' });
  }
};
