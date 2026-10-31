import mongoose from 'mongoose';
import { connectDatabase, createGuff } from './app.js';
import { loadEnvFile, readEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { describeConnectionError } from './lib/mongo.js';

loadEnvFile();
const env = readEnv();
const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'production');

try {
  await connectDatabase(env);
} catch (error) {
  log.fatal(describeConnectionError(error));
  process.exit(1);
}

const guff = await createGuff(env, log);
const port = await guff.listen(env.PORT);
log.info(`API ready on http://localhost:${port} (database "${env.MONGODB_DB}")`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info(`${signal} received, closing`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await guff.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
