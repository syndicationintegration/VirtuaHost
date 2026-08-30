# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI DJ audio-generation pipeline for an online radio station, deployed as
Netlify Functions with Netlify Blobs for storage. Google Gemini both writes
DJ script lines and synthesizes them to speech. This is deliberately just
the generation/storage core — a webhook (e.g. WhatsApp via Twilio),
scheduling, and injecting clips into a live Icecast/Liquidsoap stream are
future work that will call `POST /api/generate`, not part of this repo yet.

## Commands

- `npm install` — install dependencies
- `netlify link` — connect this directory to a Netlify site (required once,
  locally, for `netlify dev` to provide Netlify Blobs)
- `npm run dev` — `netlify dev`, runs the functions locally against
  `/api/*`; needs `GEMINI_API_KEY` set (see `.env.example`)
- `npm run build` — typecheck only (`tsc --noEmit`); Netlify bundles
  functions itself at deploy time via esbuild, there is no separate build
  output
- `npm test` — `vitest run`; Gemini and Netlify Blobs are mocked, so this
  needs no credentials and no `netlify link`
  - single test file: `npx vitest run test/lib/wav.test.ts`
  - single test by name: `npx vitest run -t "rejects invalid JSON bodies"`
- `npm run lint` — `eslint .` (flat config in `eslint.config.js`)

## Architecture

```
netlify/functions/*.mts   thin Netlify Function adapters (routing/config only)
        |
lib/handlers/*.ts         request handling logic, framework-agnostic (Request -> Response)
        |
lib/gemini.ts             Gemini client: writeDjLine() (text model), synthesizeSpeech() (TTS model)
lib/wav.ts                 wraps Gemini's raw PCM in a WAV header
lib/store.ts               Netlify Blobs wrapper: saveClip/getClip/listClips
```

- **Functions are thin on purpose.** `netlify/functions/generate.mts` and
  `clips.mts` only wire up routing (`config.path`) and Netlify's request
  context; all real logic lives in `lib/handlers/*.ts` as plain functions
  taking a `Request` and returning a `Response`. This is what makes the
  handlers unit-testable with `vitest` directly, without spinning up
  `netlify dev` — see `test/functions/*.test.ts` for the pattern (mock
  `lib/gemini.js` and `lib/store.js`, call the handler function directly).
- **One Gemini client, two models.** `lib/gemini.ts` lazily constructs a
  single `GoogleGenAI` client from `GEMINI_API_KEY` and uses it for both
  `writeDjLine()` (a `gemini-3.6-flash`-class text model, for `mode: "ai"`
  requests) and `synthesizeSpeech()` (a Gemini TTS model with
  `responseModalities: ["AUDIO"]`). `mode: "say"` requests skip
  `writeDjLine()` entirely and synthesize the given text verbatim.
- **Gemini TTS returns headerless PCM** (16-bit, mono, 24kHz by default) —
  `lib/wav.ts#pcmToWav()` wraps it in a minimal RIFF/WAVE header so stored
  clips are directly playable files, not raw samples.
- **Storage has no separate database.** `lib/store.ts` keeps a single
  Netlify Blobs store (`dj-clips`) where each clip's audio bytes are keyed
  `clips/{id}.wav`, with its `ClipMetadata` (input text/prompt, generated
  script, voice, timestamps, etc.) attached via Blobs' per-blob metadata
  feature rather than a second store or JSON file. `listClips()` lists blob
  keys under that prefix and fetches each one's metadata individually — fine
  at single-station scale, would need a real index if clip volume grew a
  lot.
- **Error handling convention**: handlers return `502` (not `500`) when a
  Gemini call itself fails (script generation or speech synthesis), and
  `400` for malformed/missing request fields — this distinguishes "your
  request was bad" from "the upstream model call failed" for callers.
