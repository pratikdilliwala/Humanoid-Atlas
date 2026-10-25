# Atlas Humanoid

A talking, head-tracking humanoid made of light, standing between glowing particle mountains.
Deployed as a static page plus two serverless functions on Vercel. Screenshots and the opening GIF for the README live in `docs/`.

## Files
- `index.html` — the whole front end in one file: Three.js r147 scene (particle mountains, neon shell figure, nerve pulses, bloom), MediaPipe face tracking, browser speech recognition, rule-based replies, and calls to the two API routes below.
- `api/chat.js` — Vercel serverless function. Sends the conversation to Google Gemini and returns a short spoken reply. Tries the models in `GEMINI_MODEL` (comma-separated) or a built-in list.
- `api/speak.js` — Vercel serverless function. Turns a reply into speech with ElevenLabs and returns MP3 audio. Voice ID defaults to `TvCFCBsne35c1ohXselu`; override with `ELEVENLABS_VOICE_ID`.

## Desktop app (`desktop/`)
An Electron app that loads the same `index.html` (it detects `window.atlas` from the preload) and runs on Windows. It isn't deployed to Vercel (`.vercelignore`).
- `main.js` — windows (see-through always-on-top "companion" or framed "full scene"), tray, global hotkey, autostart, the Gemini Live session, tool permission dialogs, activity watcher, reminders and habit nudges.
- `preload.js` — the only bridge the page gets (`window.atlas`).
- `live.js` — Gemini Live WebSocket (16 kHz PCM in, 24 kHz PCM out, transcripts, tool calls, session resumption).
- `tools.js` — everything Atlas can do on the PC. `risk: 'ask'` tools show a native Windows dialog before acting; nothing deletes permanently.
- `brain.js` — memory and learning, as files in `%APPDATA%\Atlas\brain`: `memory.md` (user-editable, weekly tidy-up with `memory.bak.md`), `journal/DAY.jsonl`, `days/DAY.md` digests and `days/YYYY-Www.md` weekly reviews, `notes/` (deep-thinking results), `index.jsonl` (embeddings for recall by meaning), `habits.json`, `reminders.json`.
- `think.js` — `think_deeply`: background agent loop on the strongest reasoning model with `web_search`, `read_webpage` and all PC tools; keeps model turns unchanged (thought signatures); saves a note and reports back.
- `proactive.js` — unprompted nudges (meeting soon, stuck on an error, break, habits), at most one per 15 minutes; notification-only in calls or Quiet mode.
- Closing the window quits the app. A second launch exits at once (`app.exit` before anything starts). The window watcher exits by itself if Atlas dies.
- `pc.js` — PowerShell helpers, Start-menu app launch, media keys, wallpaper/theme, foreground-window watcher, wallpaper accent colour.
- `cloud.js` — Gemini model discovery (live models are picked from the key's model list), one-shot `generate()`, and the web build's `api/*.js` reused for the non-live fallback.
- `store.js` — settings; API keys encrypted with `safeStorage`. In dev, a repo-root `.env.local` fills in missing keys.
- Run: `cd desktop`, `npm install`, `npm start`. Installer: `npm run dist` → `desktop/dist/Atlas Setup <version>.exe`.

## Environment variables (set in Vercel, never in code)
- `GEMINI_API_KEY` — required for open-ended answers.
- `ELEVENLABS_API_KEY` — required for the custom voice. Without it Atlas falls back to the browser voice.
- Optional: `GEMINI_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` (default `eleven_flash_v2_5`).

Free-tier notes: ElevenLabs free accounts cannot use Voice Library voices through the API, only default or self-designed voices. Both keys are personal-use free tiers.

## Run locally
The camera and the API routes need http(s), not file://.
- With the Vercel CLI (runs the API routes too): `npm i -g vercel`, then `vercel link` (pick your Vercel project), `vercel env pull`, `vercel dev`, and open http://localhost:3000.
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
- Desktop real-time voice: the `live` object, `micOn()` (resampling AudioWorklet), `playChunk()`; desktop wiring after `wakeUp()`.
- Mood (time of day, wallpaper accent): `MOODS` and `applyMood()`; companion transparency is the `finish` pass (`uClear`).
