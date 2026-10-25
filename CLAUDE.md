# Atlas Humanoid

A talking, head-tracking humanoid made of light, standing between glowing particle mountains.
Live at https://atlas-humanoid.vercel.app (Vercel project `atlas-humanoid`, protected by Vercel Authentication).

## Files
- `index.html` — the whole front end in one file: Three.js r147 scene (particle mountains, neon shell figure, nerve pulses, bloom), MediaPipe face tracking, browser speech recognition, rule-based replies, and calls to the two API routes below.
- `api/chat.js` — Vercel serverless function. Sends the conversation to Google Gemini and returns a short spoken reply. Tries the models in `GEMINI_MODEL` (comma-separated) or a built-in list.
- `api/speak.js` — Vercel serverless function. Turns a reply into speech with ElevenLabs and returns MP3 audio. Voice ID defaults to `TvCFCBsne35c1ohXselu`; override with `ELEVENLABS_VOICE_ID`.

## Environment variables (set in Vercel, never in code)
- `GEMINI_API_KEY` — required for open-ended answers.
- `ELEVENLABS_API_KEY` — required for the custom voice. Without it Atlas falls back to the browser voice.
- Optional: `GEMINI_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` (default `eleven_flash_v2_5`).

Free-tier notes: ElevenLabs free accounts cannot use Voice Library voices through the API, only default or self-designed voices. Both keys are personal-use free tiers.

## Run locally
The camera and the API routes need http(s), not file://.
- With the Vercel CLI (runs the API routes too): `npm i -g vercel`, then `vercel link` (pick the existing `atlas-humanoid` project), `vercel env pull`, `vercel dev`, and open http://localhost:3000.
- Front end only: `npx serve .` and open the printed localhost URL. Atlas will use the browser voice and rule-based replies.

## Deploy
`vercel --prod` from this folder (after `vercel link`).

## Where things live in index.html
- Tracking sensitivity: `aimAt()` and the `pointermove` handler; smoothing in `frame()`.
- Figure shape: `W_PTS`, `DF_PTS`, `DB_PTS`, `headAt()`, `neckAt`, `torsoAt`.
- Nerves: the `addNerve()` block and `NERVE_VERT` shader.
- Mountains: `buildPeaks()`, `terrainH()`, `buildTerrain()`.
- Replies: `RULES` (instant answers) and `aiReply()` (Gemini fallback).
- Voice: `say()`, `cloudSpeak()`, `browserSay()`.
