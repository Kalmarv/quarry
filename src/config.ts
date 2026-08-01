import { z } from "zod";

const schema = z.object({
  SEERR_URL: z.string().url(),
  SEERR_API_KEY: z.string().min(1),
  PROWLARR_URL: z.string().url(),
  PROWLARR_API_KEY: z.string().min(1),
  QBIT_URL: z.string().url(),
  QBIT_USERNAME: z.string().min(1),
  QBIT_PASSWORD: z.string().min(1),
  JELLYFIN_URL: z.string().url(),
  JELLYFIN_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  LIBRARY_MOVIES: z.string().min(1),
  LIBRARY_TV: z.string().min(1),
  DOWNLOADS_PATH: z.string().min(1),
  QBIT_PATH_PREFIX: z.string().default("/downloads"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function config(): Config {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
