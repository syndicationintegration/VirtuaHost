import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({
  writeDjLine: vi.fn(),
  synthesizeSpeech: vi.fn(),
  DEFAULT_VOICE: "Kore",
}));
vi.mock("../../lib/store.js", () => ({
  saveClip: vi.fn(),
}));

import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";
import { saveClip } from "../../lib/store.js";
import { handleGenerate } from "../../lib/handlers/generate.js";

const mockedWriteDjLine = vi.mocked(writeDjLine);
const mockedSynthesizeSpeech = vi.mocked(synthesizeSpeech);
const mockedSaveClip = vi.mocked(saveClip);

interface GenerateResponseBody {
  id: string;
  scriptText: string;
  audioUrl: string;
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/generate", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("handleGenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSynthesizeSpeech.mockResolvedValue({ pcm: Buffer.from([1, 2, 3]), mimeType: "audio/pcm" });
    mockedSaveClip.mockResolvedValue(undefined);
  });

  it("rejects non-POST requests", async () => {
    const res = await handleGenerate(jsonRequest("GET"));
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON bodies", async () => {
    const req = new Request("http://localhost/api/generate", { method: "POST", body: "not json" });
    const res = await handleGenerate(req);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown mode", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "sing" }));
    expect(res.status).toBe(400);
  });

  it("requires text for mode 'say'", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "say" }));
    expect(res.status).toBe(400);
    expect(mockedSynthesizeSpeech).not.toHaveBeenCalled();
  });

  it("requires prompt for mode 'ai'", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "ai" }));
    expect(res.status).toBe(400);
  });

  it("synthesizes verbatim text for mode 'say' without calling the LLM", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello listeners" }));

    expect(res.status).toBe(201);
    expect(mockedWriteDjLine).not.toHaveBeenCalled();
    expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("hello listeners");

    const body = (await res.json()) as GenerateResponseBody;
    expect(body.scriptText).toBe("hello listeners");
    expect(body.audioUrl).toBe(`/api/clips/${body.id}`);
    expect(mockedSaveClip).toHaveBeenCalledTimes(1);
  });

  it("writes a DJ line via Gemini for mode 'ai' before synthesizing", async () => {
    mockedWriteDjLine.mockResolvedValue("Coming up next, a certified banger.");

    const res = await handleGenerate(jsonRequest("POST", { mode: "ai", prompt: "hype the next song" }));

    expect(res.status).toBe(201);
    expect(mockedWriteDjLine).toHaveBeenCalledWith("hype the next song");
    expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("Coming up next, a certified banger.");

    const body = (await res.json()) as GenerateResponseBody;
    expect(body.scriptText).toBe("Coming up next, a certified banger.");
  });

  it("returns 502 when script generation fails", async () => {
    mockedWriteDjLine.mockRejectedValue(new Error("quota exceeded"));

    const res = await handleGenerate(jsonRequest("POST", { mode: "ai", prompt: "hype it up" }));

    expect(res.status).toBe(502);
    expect(mockedSaveClip).not.toHaveBeenCalled();
  });

  it("returns 502 when speech synthesis fails", async () => {
    mockedSynthesizeSpeech.mockRejectedValue(new Error("tts unavailable"));

    const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello" }));

    expect(res.status).toBe(502);
    expect(mockedSaveClip).not.toHaveBeenCalled();
  });
});
