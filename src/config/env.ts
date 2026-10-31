import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The guff_backend folder, whether we run from src/ (tsx) or dist/ (compiled). */
export const BACKEND_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const ENV_FILE = join(BACKEND_DIR, '.env');

/** Loads guff_backend/.env if it exists. Values already in the environment win. */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** Any MongoDB connection string: a local server or MongoDB Atlas (mongodb+srv://…). */
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017'),
  /** Guff keeps everything in this one database, so it can share a cluster with other apps. */
  MONGODB_DB: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,38}$/, 'MONGODB_DB may only use letters, digits, - and _')
    .default('guff'),
  /**
   * "memory": one API process (the default). "mongo": several API processes share
   * real-time events through MongoDB change streams (needs a replica set, e.g. Atlas).
   */
  SOCKET_ADAPTER: z.enum(['memory', 'mongo']).default('memory'),
  /** The website's address. On Render it defaults to the service's own URL. */
  CORS_ORIGIN: z.string().default('http://localhost:5176'),
  /**
   * Serve the built website (guff_frontend/dist) from the API too, so the whole app has one address.
   * Used when deployed; in development Vite serves the website.
   */
  SERVE_WEB: z.stringbool().default(false),
  /** How many proxies sit in front of the API (Express "trust proxy"): "loopback", a number, or "true". */
  TRUST_PROXY: z.string().default('loopback'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),
  /** Sign-in and sign-up attempts allowed per IP address every 10 minutes. */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  /** Demo teammates answer DMs and mentions while nobody is signed in as them. */
  DEMO_REPLIES: z.stringbool().default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const input = { ...source };
  // Render tells each service its public address.
  if (!input.CORS_ORIGIN && input.RENDER_EXTERNAL_URL)
    input.CORS_ORIGIN = input.RENDER_EXTERNAL_URL;
  const result = schema.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(
      `Some settings in guff_backend/.env are missing or wrong:\n${lines.join('\n')}\n` +
        'Run "npm run setup" in the guff_backend folder to create them.',
    );
  }
  return result.data;
}
