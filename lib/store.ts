import { getStore } from "@netlify/blobs";
import type { ClipMetadata } from "./types.js";

const STORE_NAME = "dj-clips";
const CLIP_PREFIX = "clips/";

function store() {
  return getStore(STORE_NAME);
}

function clipKey(id: string): string {
  return `${CLIP_PREFIX}${id}.wav`;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export async function saveClip(id: string, audio: Buffer, metadata: ClipMetadata): Promise<void> {
  await store().set(clipKey(id), toArrayBuffer(audio), {
    metadata: metadata as unknown as Record<string, unknown>,
  });
}

export interface StoredClip {
  data: ArrayBuffer;
  metadata: ClipMetadata;
}

export async function getClip(id: string): Promise<StoredClip | null> {
  const result = await store().getWithMetadata(clipKey(id), { type: "arrayBuffer" });
  if (!result) {
    return null;
  }
  return { data: result.data, metadata: result.metadata as unknown as ClipMetadata };
}

export async function listClips(): Promise<ClipMetadata[]> {
  const { blobs } = await store().list({ prefix: CLIP_PREFIX });

  const metadataEntries = await Promise.all(
    blobs.map(async ({ key }) => {
      const entry = await store().getMetadata(key);
      return entry?.metadata as unknown as ClipMetadata | undefined;
    }),
  );

  return metadataEntries
    .filter((metadata): metadata is ClipMetadata => Boolean(metadata))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
