import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';

const require = createRequire(import.meta.url);

function prettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function createLogger(level: string, production: boolean): Logger {
  // Readable lines in the API window on a PC; JSON lines in production (Docker).
  if (!production && prettyAvailable()) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }
  return pino({ level });
}
