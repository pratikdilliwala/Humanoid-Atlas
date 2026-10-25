# Humanoid Atlas

A glowing humanoid made of light that stands between particle mountains, turns its head to follow you through your webcam, listens to you, and answers out loud in a deep voice.

- **Look:** Three.js particle figure with a neon outline, an orange face core, and nerves that pulse with energy, set against dotted mountains.
- **Tracking:** MediaPipe face detection, with motion and pointer fallbacks.
- **Brain:** instant built-in replies, plus Google Gemini for everything else (`api/chat.js`).
- **Voice:** ElevenLabs text-to-speech (`api/speak.js`), with the browser voice as a fallback.

## Setup
Deploy to Vercel and add these environment variables:
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- Optional: `ELEVENLABS_VOICE_ID`, `GEMINI_MODEL`, `ELEVENLABS_MODEL`

Run locally with `vercel dev` (the camera needs http://localhost or https, not a file:// path).

See `CLAUDE.md` for a map of the code.
