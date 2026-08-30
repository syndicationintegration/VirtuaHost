import { getClip, listClips } from "../store.js";

export async function handleClips(req: Request, id: string | undefined): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!id) {
    const clips = await listClips();
    return Response.json({ clips });
  }

  const clip = await getClip(id);
  if (!clip) {
    return Response.json({ error: "Clip not found" }, { status: 404 });
  }

  return new Response(clip.data, {
    status: 200,
    headers: {
      "Content-Type": clip.metadata.mimeType,
      "Content-Length": String(clip.data.byteLength),
    },
  });
}
