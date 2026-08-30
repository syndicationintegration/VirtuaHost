import { GoogleGenAI } from "@google/genai";

const TEXT_MODEL = "gemini-2.5-flash";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
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

export async function synthesizeSpeech(
  text: string,
  voice: string = DEFAULT_VOICE,
): Promise<SynthesizedSpeech> {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: text,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error("Gemini returned no audio data");
  }

  return {
    pcm: Buffer.from(inlineData.data, "base64"),
    mimeType: inlineData.mimeType ?? "audio/pcm",
  };
}
