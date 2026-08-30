// Gemini's TTS models return headerless 16-bit signed-PCM audio (24kHz mono
// by default). This wraps that raw PCM in a minimal WAV (RIFF) header so the
// stored file is directly playable by browsers, <audio> tags, and Liquidsoap.

const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
export const DEFAULT_SAMPLE_RATE = 24000;

export function pcmToWav(pcm: Buffer, sampleRate: number = DEFAULT_SAMPLE_RATE): Buffer {
  const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
