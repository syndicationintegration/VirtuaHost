# Providers, clips, links and cloud sharing

Everything here is configured with environment variables. The full list, with
comments, is in `googleTextToSpeech1/.env.example`.

## Speech providers

Set `TTS_PROVIDER` to one name, or a comma list that is tried in order, for example
`google,piper` (Google normally, a free local voice if Google fails or is over quota).

| Name | Needs | Notes |
|------|-------|-------|
| `google` | `GOOGLE_APPLICATION_CREDENTIALS` | SSML, pitch, speed and gain. The default. |
| `openai` | `OPENAI_API_KEY` | Speed only. No SSML. Also works with any server that implements `/audio/speech` through `OPENAI_BASE_URL`. |
| `elevenlabs` | `ELEVENLABS_API_KEY`, voices in `ELEVENLABS_VOICES` | Your voice clones, audio tags (`[softly]`), and multi-voice dialogue (see below). MP3 only. No SSML or speed. |
| `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_TTS_MODEL`, `OPENROUTER_TTS_VOICES` | OpenRouter's speech models (OpenAI-compatible `/audio/speech`). MP3. Not ElevenLabs, so no clones. |
| `piper` | the `piper` program and `PIPER_MODELS` (.onnx files) | Free and offline. WAV output. Speed only. A voice on the VPS needs about 60 MB of disk per model. |

Enabled providers can be chosen per request with `provider` (the UI shows a picker when more than one is
enabled); a chosen provider is used alone, with no fallback. `GET /providers` lists them with their capabilities,
`GET /tts/voices?provider=` the voices, `GET /tts/models?provider=` the models where the provider has a list.

**ElevenLabs dialogue.** Send `turns: [{ "voice": "Rocky", "text": "..." }, ...]` (up to 60 lines, 10 voices, 10,000
characters, see `MAX_DIALOGUE_CHARS`) instead of `text`. Voices are names from `ELEVENLABS_VOICES` or raw voice ids.
The UI has a Dialogue mode. Scripts over the API's 2,000-character limit are split and joined with ffmpeg.

**Receiving audio from elsewhere.** `POST /ingest` (audio bytes) and `POST /ingest/url` (a link) accept finished
audio, for example from VirtuaHost. See [docs/INTEGRATION.md](../../docs/INTEGRATION.md).

The UI asks the server for the voice list and hides the controls a provider does
not support (SSML, pitch, speed, gain), so the form always matches the active
provider. A voice chosen for one provider is not sent to a fallback provider.

## AI drafting, including OpenRouter

Set `LLM_PROVIDER` (also a fallback list). Leave it empty to hide the feature.
The "Draft with AI" button turns a short brief into announcement text. The text
is only put in the box; a person still presses Announce.

| Name | Needs |
|------|-------|
| `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (any id from openrouter.ai/models, default `openai/gpt-4o-mini`) |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| `openai` | `OPENAI_API_KEY`, `OPENAI_LLM_MODEL` |
| `ollama` | `OLLAMA_MODEL` (local models, no key) |

OpenRouter extras: `OPENROUTER_FALLBACK_MODELS` is a comma list of models
OpenRouter tries in order if the first is unavailable. `OPENROUTER_REFERER` and
`OPENROUTER_TITLE` set the optional attribution headers. `GET /llm/models`
lists the available models.

Costs: every speech or drafting call is rate limited per client
(`RATE_LIMIT_PER_MIN`, default 30), and text length is capped
(`MAX_TEXT_CHARS`, default 500).

## The clip library

Every announcement is saved. The clip's id is a hash of the text, voice and
settings, so saying the same thing again reuses the saved audio and makes no
speech API call. The Library tab searches, favorites, tags, replays, schedules
and shares clips.

- Stored in `DATA_DIR/library.json` (a single file, written atomically) with the
  audio in `CLIPS_DIR`. A JSON file was chosen instead of SQLite so it runs on any
  Node version with nothing to compile; it is fine for thousands of clips.
- With `DATABASE_URL` set (a Neon Postgres connection string, `sslmode=require`),
  the clips and schedules are stored in one table, `app_store`, as one JSON row
  per kind. On first start with an empty table, `DATA_DIR/library.json` is imported
  once and kept as it was. Without `DATABASE_URL` nothing changes: the JSON file is
  used. The database holds the library only; audio stays in `CLIPS_DIR`. The store
  writes the whole row per save, so keep one writing process unless you have
  tested concurrent use.
- `CLIP_CACHE_MB` caps the audio on disk. Beyond it the least recently played
  clips that are not favorites are deleted; their entries stay and the audio is
  regenerated the next time they are played.

## Schedules

Once, or every N minutes/hours/days, optionally stopping after N runs. Schedules
are saved and survive restarts. If the server was off for more than 5 minutes
past a run time, that run is skipped and recorded as "missed", not replayed late.
Times are entered in your browser's time zone.

## Links players can stream

"Share" in the UI creates a signed link such as
`https://api.example.com/a/<id>/<title>.ogg?exp=...&sig=...`.

- No login is needed to open it, but it cannot be guessed or extended, and it
  stops working at the expiry (1 hour to 30 days).
- It supports seeking (HTTP range requests), so players and browsers can stream it.
- Set `PUBLIC_URL` to the public https address of the backend, and `STREAM_SECRET`
  (or it falls back to `SESSION_SECRET`). Changing the secret revokes all links.
- It is served by the VPS, so use it for occasional sharing. A deleted or evicted
  clip returns 404.

## Cloud sharing

"Share" can also upload the file to your cloud and give back a public link,
plus a direct audio link for players where the provider supports one.

### Google Drive (any rclone remote)

1. Install rclone and run `rclone config`; choose `n`, a name like `gdrive`, and
   `drive`. On a server with no browser, run `rclone authorize "drive"` on your
   computer and paste the token back. Create your own Google API client id if
   the shared one is rate limited.
2. Check it: `rclone lsd gdrive:`
3. Set `STORAGE_RCLONE_REMOTE=gdrive:ChipsVoice` (the folder is created) and
   optionally `STORAGE_RCLONE_LABEL="Google Drive"`.

The upload uses `rclone copyto` and the link uses `rclone link`, which creates an
"anyone with the link" share. The direct link is Google's download form of the
same file. Google may show a confirmation page for large files, which is not an
issue for short clips. The same settings work for Dropbox and OneDrive.

### ownCloud (and Nextcloud)

1. In ownCloud: Settings, Security, create an **app password** for this app.
2. Set `OWNCLOUD_URL` (the server root, for example `https://cloud.example.com`),
   `OWNCLOUD_USER`, `OWNCLOUD_PASSWORD` (the app password) and optionally
   `OWNCLOUD_FOLDER`.

The server uploads by WebDAV and creates the public link through ownCloud's
sharing API, reusing an existing link for the same file. The direct link is the
share link with `/download`. Public links must be allowed by your ownCloud admin.

With both configured, the UI shows a button for each; `STORAGE_DEFAULT` picks one
for requests that do not name it.

### Music rotation from the same clouds

`scripts/rotate_music.py` uses rclone too, so the same remotes work as the music
source. For ownCloud use an rclone remote of type `webdav`, vendor `owncloud`,
URL `https://cloud.example.com/remote.php/dav/files/USER/`, and an app
password. See [MUSIC-ROTATION.md](MUSIC-ROTATION.md).

## What was verified

Unit and integration tests (`npm test` in `googleTextToSpeech1/`, 135 tests) cover the providers against
mock servers, the clip catalogue, the scheduler, both storage adapters against a
mock rclone and a mock ownCloud server, signed links including range requests,
and the API. The real vendors (Google, OpenRouter, ElevenLabs, Google Drive,
ownCloud) have not been called from here, so run each once with real credentials.
