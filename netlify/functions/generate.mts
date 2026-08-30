import type { Config } from "@netlify/functions";
import { handleGenerate } from "../../lib/handlers/generate.js";

export default (req: Request) => handleGenerate(req);

export const config: Config = {
  path: "/api/generate",
};
