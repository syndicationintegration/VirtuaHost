# VirtuaHost — AI DJ audio pipeline

Generates and stores AI DJ audio clips for an online radio station, built on
Netlify Functions (compute) and Netlify Blobs (storage), with Google Gemini
doing both the script writing and the text-to-speech.

This is the core pipeline only. Triggering it from WhatsApp, scheduling
announcements, and injecting clips into a live Icecast/Liquidsoap stream are
deliberately not built yet — they're expected to call `POST /api/generate`
once they exist.

## Setup

1. `npm install`
2. `netlify link` (or `netlify init`) to connect this directory to a Netlify
   site — this is what makes Netlify Blobs available locally.
3. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (from
   [Google AI Studio](https://aistudio.google.com/)). `STATION_NAME` and
   `GEMINI_TTS_VOICE` are optional.
4. `netlify dev`

## API

### `POST /api/generate`

```json
{ "mode": "say", "text": "Coming up, the top of the hour news." }
```

or

```json
{ "mode": "ai", "prompt": "hype up the next song, it's a summer anthem" }
```

`mode: "say"` speaks the given `text` verbatim. `mode: "ai"` sends `prompt`
to Gemini first to write a DJ line, then synthesizes that. Response:

```json
{ "id": "...", "scriptText": "...", "audioUrl": "/api/clips/..." }
```

### `GET /api/clips`

Returns `{ "clips": [ClipMetadata, ...] }`, newest first.

### `GET /api/clips/:id`

Returns the clip's audio as `audio/wav`.

## Scripts

- `npm run dev` — `netlify dev`, runs the functions locally
- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — run the unit tests (`vitest`); no credentials required, Gemini
  and Blobs are mocked
- `npm run lint` — `eslint .`
