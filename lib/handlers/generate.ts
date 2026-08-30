import { randomUUID } from "node:crypto";
import { writeDjLine, synthesizeSpeech, DEFAULT_VOICE } from "../gemini.js";
import { pcmToWav } from "../wav.js";
import { saveClip } from "../store.js";
import type { GenerateRequest, ClipMetadata } from "../types.js";

export async function handleGenerate(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const { mode } = body;
  if (mode !== "say" && mode !== "ai") {
    return Response.json({ error: 'mode must be "say" or "ai"' }, { status: 400 });
  }

  const input = mode === "say" ? body.text : body.prompt;
  if (!input?.trim()) {
    return Response.json(
      { error: mode === "say" ? 'text is required for mode "say"' : 'prompt is required for mode "ai"' },
      { status: 400 },
    );
  }

  let scriptText: string;
  try {
    scriptText = mode === "ai" ? await writeDjLine(input) : input;
  } catch (err) {
    return Response.json({ error: `Script generation failed: ${(err as Error).message}` }, { status: 502 });
  }

  let pcm: Buffer;
  let mimeType: string;
  try {
    ({ pcm, mimeType } = await synthesizeSpeech(scriptText));
  } catch (err) {
    return Response.json({ error: `Speech synthesis failed: ${(err as Error).message}` }, { status: 502 });
  }
  void mimeType; // Gemini's inline mimeType describes the raw PCM; the stored file is always audio/wav.

  const wav = pcmToWav(pcm);
  const id = randomUUID();
  const metadata: ClipMetadata = {
    id,
    createdAt: new Date().toISOString(),
    mode,
    input,
    scriptText,
    voice: process.env.GEMINI_TTS_VOICE ?? DEFAULT_VOICE,
    mimeType: "audio/wav",
    byteSize: wav.length,
  };

  await saveClip(id, wav, metadata);

  return Response.json({ id, scriptText, audioUrl: `/api/clips/${id}` }, { status: 201 });
}
