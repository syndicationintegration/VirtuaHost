import type { Config, Context } from "@netlify/functions";
import { handleClips } from "../../lib/handlers/clips.js";

export default (req: Request, context: Context) => handleClips(req, context.params.id);

export const config: Config = {
  path: ["/api/clips", "/api/clips/:id"],
};
