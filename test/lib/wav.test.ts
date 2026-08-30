import { describe, it, expect } from "vitest";
import { pcmToWav } from "../../lib/wav.js";

describe("pcmToWav", () => {
  it("prefixes a 44-byte RIFF/WAVE header", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = pcmToWav(pcm);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("encodes the correct data chunk size and total RIFF size", () => {
    const pcm = Buffer.alloc(1000, 0x7f);
    const wav = pcmToWav(pcm);

    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
  });

  it("defaults to 24kHz mono 16-bit PCM format fields", () => {
    const wav = pcmToWav(Buffer.alloc(10));

    expect(wav.readUInt16LE(20)).toBe(1); // PCM format tag
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("respects a custom sample rate", () => {
    const wav = pcmToWav(Buffer.alloc(10), 16000);
    expect(wav.readUInt32LE(24)).toBe(16000);
  });

  it("appends the original PCM bytes unchanged after the header", () => {
    const pcm = Buffer.from([9, 8, 7, 6, 5]);
    const wav = pcmToWav(pcm);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
