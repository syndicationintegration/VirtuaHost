import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/store.js", () => ({
  getClip: vi.fn(),
  listClips: vi.fn(),
}));

import { getClip, listClips } from "../../lib/store.js";
import { handleClips } from "../../lib/handlers/clips.js";
import type { ClipMetadata } from "../../lib/types.js";

const mockedGetClip = vi.mocked(getClip);
const mockedListClips = vi.mocked(listClips);

function getRequest(): Request {
  return new Request("http://localhost/api/clips", { method: "GET" });
}

const sampleMetadata: ClipMetadata = {
  id: "abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  mode: "say",
  input: "hello",
  scriptText: "hello",
  voice: "Kore",
  mimeType: "audio/wav",
  byteSize: 4,
};

describe("handleClips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-GET requests", async () => {
    const req = new Request("http://localhost/api/clips", { method: "POST" });
    const res = await handleClips(req, undefined);
    expect(res.status).toBe(405);
  });

  it("lists clips when no id is given", async () => {
    mockedListClips.mockResolvedValue([sampleMetadata]);

    const res = await handleClips(getRequest(), undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { clips: ClipMetadata[] };
    expect(body.clips).toEqual([sampleMetadata]);
  });

  it("returns 404 when the clip does not exist", async () => {
    mockedGetClip.mockResolvedValue(null);

    const res = await handleClips(getRequest(), "missing");

    expect(res.status).toBe(404);
  });

  it("streams the clip's audio bytes with the stored mime type", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    mockedGetClip.mockResolvedValue({ data, metadata: sampleMetadata });

    const res = await handleClips(getRequest(), "abc");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(res.headers.get("Content-Length")).toBe("4");
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });
});
