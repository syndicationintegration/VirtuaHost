import { GoogleGenAI } from "@google/genai";

const TEXT_MODEL = "gemini-3.6-flash";
const TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_VOICE = "Kore";

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export async function writeDjLine(prompt: string): Promise<string> {
  const ai = getClient();
  const stationName = process.env.STATION_NAME ?? "the station";
  const systemInstruction =
    `You are the AI on-air DJ for ${stationName}. Write a short, energetic, ` +
    "broadcast-ready line to be read aloud on-air (2-3 sentences max). " +
    "Output only the words to be spoken -- no stage directions, sound effect " +
    "cues, emoji, or markdown.";

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: prompt,
    config: { systemInstruction },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned no script text");
  }
  return text;
}

export interface SynthesizedSpeech {
  pcm: Buffer;
  mimeType: string;
}

interface GenerateContentAudioResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
    };
  }>;
  error?: { message?: string };
}

// Calls the Gemini REST endpoint directly rather than going through
// @google/genai's generateContent() for this call: the SDK does its own
// client-side model/capability validation, which lagged behind this
// (very recent, preview) TTS model in at least one deployment environment
// even though the model works fine against Google's actual API.
export async function synthesizeSpeech(
  text: string,
  voice: string = DEFAULT_VOICE,
): Promise<SynthesizedSpeech> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
    },
  );

  const body = (await res.json()) as GenerateContentAudioResponse;
  if (!res.ok) {
    throw new Error(body.error?.message ?? `Gemini TTS request failed with status ${res.status}`);
  }

  const inlineData = body.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error("Gemini returned no audio data");
  }

  return {
    pcm: Buffer.from(inlineData.data, "base64"),
    mimeType: inlineData.mimeType ?? "audio/pcm",
  };
}
