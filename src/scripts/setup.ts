/**
 * npm run setup             create guff_backend/.env, connect to MongoDB, build indexes, load the demo
 * npm run setup -- --reset  delete Guff's data first (asks to confirm; add --yes to skip that)
 * npm run setup -- --no-seed  don't load the demo data
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import mongoose from 'mongoose';
import { ENV_FILE, loadEnvFile, readEnv } from '../config/env.js';
import {
  connectWithDnsFallback,
  describeConnectionError,
  tidyConnectionString,
} from '../lib/mongo.js';
import { User, ensureIndexes } from '../models/index.js';
import { DEMO_PASSWORD, PEOPLE, emailOf } from '../seed/demo-script.js';
import { seedDemo } from '../seed/seed.js';

const args = new Set(process.argv.slice(2));
const RESET = args.has('--reset');
const NO_SEED = args.has('--no-seed');
const YES = args.has('--yes');
const interactive = Boolean(process.stdin.isTTY);
// In Docker the settings come from the environment, not from a file.
const USES_ENV_FILE = existsSync(ENV_FILE) || !process.env.JWT_SECRET;

const say = (line = '') => console.log(line);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function setEnvValue(key: string, value: string) {
  const line = `${key}="${value}"`;
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i === -1) lines.push(line);
  else lines[i] = line;
  writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n*$/, '')}\n`);
  process.env[key] = value;
}

function createEnvFile() {
  const content = [
    '# Guff API settings. Created by "npm run setup". Keep this file private.',
    'NODE_ENV=development',
    'PORT=4100',
    '# A local MongoDB, or your MongoDB Atlas connection string (mongodb+srv://...)',
    'MONGODB_URI="mongodb://127.0.0.1:27017"',
    'MONGODB_DB=guff',
    'CORS_ORIGIN=http://localhost:5176',
    `JWT_SECRET=${randomBytes(48).toString('base64url')}`,
    'ACCESS_TOKEN_TTL_SECONDS=900',
    'REFRESH_TOKEN_TTL_DAYS=14',
    'MAX_UPLOAD_MB=10',
    'AUTH_RATE_LIMIT=30',
    '# Demo teammates answer your DMs and @mentions. Set to false for a real team.',
    'DEMO_REPLIES=true',
    '# memory = one API process. mongo = several processes share events (needs Atlas or a replica set).',
    'SOCKET_ADAPTER=memory',
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, content);
  say('✔ Created guff_backend/.env with a fresh secret key');
}

/** Hides the password when showing a connection string. */
const masked = (uri: string) => uri.replace(/(mongodb(?:\+srv)?:\/\/[^:/@]+:)[^@]*@/, '$1••••••@');

async function tryConnect(uri: string, dbName: string): Promise<string | null> {
  try {
    await connectWithDnsFallback(uri, dbName, 8000);
    return null;
  } catch (error) {
    await mongoose.disconnect().catch(() => {});
    return describeConnectionError(error);
  }
}

/** Tidies a saved or pasted string and connects with it. */
async function attempt(
  raw: string,
  dbName: string,
): Promise<{ uri: string; problem: string | null }> {
  const tidy = tidyConnectionString(raw);
  if (!tidy.ok) return { uri: raw, problem: tidy.problem };
  if (tidy.encoded) say('✔ Encoded the special characters in the password');
  say(`… Connecting to MongoDB at ${masked(tidy.uri)}`);
  return { uri: tidy.uri, problem: await tryConnect(tidy.uri, dbName) };
}

async function findDatabase(dbName: string): Promise<void> {
  let uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
  const first = await attempt(uri, dbName);
  if (!first.problem) {
    if (first.uri !== uri && USES_ENV_FILE) {
      setEnvValue('MONGODB_URI', first.uri);
      say('✔ Fixed MONGODB_URI in guff_backend/.env');
    }
    return;
  }

  say(`✖ ${first.problem}`);
  if (!interactive) {
    say('Set MONGODB_URI in guff_backend/.env (or the environment) and run setup again.');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  say('');
  say(bold('Guff needs a MongoDB database.'));
  say('With MongoDB Atlas: Clusters → Connect → Drivers, copy the connection string,');
  say('and replace <db_password> with your database user’s password.');
  say('Or install MongoDB Community Server on this PC, then just press Enter to try again.');
  try {
    for (;;) {
      say('');
      const answer = (
        await rl.question('Paste the connection string (Enter = try again, q = quit): ')
      ).trim();
      if (answer.toLowerCase() === 'q') process.exit(1);
      if (answer) uri = answer;
      const result = await attempt(uri, dbName);
      if (!result.problem) {
        if (USES_ENV_FILE) {
          setEnvValue('MONGODB_URI', result.uri);
          say('✔ Saved the connection string in guff_backend/.env');
        }
        return;
      }
      say(`✖ ${result.problem}`);
    }
  } finally {
    rl.close();
  }
}

async function confirmReset(dbName: string): Promise<boolean> {
  if (YES || !interactive) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This deletes everything in the database "${dbName}". Type yes to continue: `,
  );
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main() {
  say(bold('Guff setup'));
  if (USES_ENV_FILE && !existsSync(ENV_FILE)) createEnvFile();
  loadEnvFile();
  const env = readEnv();

  await findDatabase(env.MONGODB_DB);
  say(`✔ Connected (database "${env.MONGODB_DB}")`);

  if (RESET) {
    if (!(await confirmReset(env.MONGODB_DB))) {
      say('Nothing was deleted.');
      await mongoose.disconnect();
      return;
    }
    // Collection by collection, so a database user with plain read/write access can do it.
    const db = mongoose.connection.db!;
    for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (!c.name.startsWith('system.')) await db.dropCollection(c.name);
    }
    say('✔ Deleted Guff’s data');
  }

  await ensureIndexes();
  say('✔ Indexes are in place');

  if (NO_SEED) {
    say('Skipped the demo data (--no-seed)');
  } else if ((await User.estimatedDocumentCount()) > 0) {
    say('✔ Existing data kept (npm run db:reset starts over with the demo)');
  } else {
    say('… Loading the demo conversations (a few seconds; longer over the internet to Atlas)');
    const summary = await seedDemo(env.JWT_SECRET);
    say(
      `✔ Loaded the demo: ${summary.people} people, ${summary.channels} conversations, ${summary.messages} messages`,
    );
  }

  await mongoose.disconnect();
  say('');
  say(bold('Demo sign-ins') + ` (password ${DEMO_PASSWORD})`);
  say(`  ${emailOf('aarav')}  ${PEOPLE.aarav.name}, ${PEOPLE.aarav.title}`);
  say(`  ${emailOf('sita')}   ${PEOPLE.sita.name}, ${PEOPLE.sita.title}`);
  say('Tip: sign in as Aarav in one window and Sita in a private window to chat with yourself.');
  say('');
}

main().catch(async (error: unknown) => {
  console.error(`✖ Setup failed: ${error instanceof Error ? error.message : String(error)}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
