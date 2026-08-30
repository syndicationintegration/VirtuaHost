export type GenerateMode = "say" | "ai";

export interface GenerateRequest {
  mode: GenerateMode;
  text?: string;
  prompt?: string;
}

export interface ClipMetadata {
  id: string;
  createdAt: string;
  mode: GenerateMode;
  input: string;
  scriptText: string;
  voice: string;
  mimeType: string;
  byteSize: number;
}
