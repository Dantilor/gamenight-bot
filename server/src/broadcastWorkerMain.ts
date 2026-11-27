import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveBroadcastStore, type BroadcastStore, type CampaignKind } from './broadcastStore.js';
import {
  checkTelegramApi,
  createTelegramSender,
  DEFAULT_MIN_INTERVAL_MS,
  runBroadcastDaemon,
  runBroadcastWorker,
  type DaemonSettings,
} from './broadcastWorker.js';
import { readConfig } from './config.js';
import { closeDb } from './db.js';
import { redact } from './log.js';
import { usableHttpsUrl } from './webhookReply.js';

export type WorkerArgs =
  | { mode: 'check' }
  | { mode: 'status' }
  | { mode: 'schema' }
  | { mode: 'daemon' }
  | { mode: 'healthcheck' }
  | { mode: 'send'; kind: CampaignKind | undefined; maxSends: number | undefined }
  | { mode: 'usage'; reason: string };

export const USAGE =
  'Usage: npm run broadcast-worker -- <mode>\n' +
  '  --daemon            run forever: poll the queue and send (tests only unless BROADCAST_MASS_ENABLED=true)\n' +
  '  --check             reach Telegram with getMe only; sends nothing\n' +
  '  --schema            read-only: report missing migrations 002/003 and missing privileges\n' +
  '  --status            read-only: eligible ads recipients, informational audience, queue depth; sends nothing\n' +
  '  --healthcheck       exit 0 when the daemon heartbeat is fresh (for Docker HEALTHCHECK)\n' +
  '  --only-test         one pass over queued TEST campaigns only; a mass queue is never touched\n' +
  '  --send-mass         one pass over test and mass campaigns (use only after the owner approves)\n' +
  '  --max-sends=N       optional cap on messages in one pass';

const MODES = ['--check', '--status', '--schema', '--daemon', '--healthcheck', '--only-test', '--send-mass'];

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const modes = flags.filter((flag) => MODES.includes(flag));
  if (modes.length !== 1) return { mode: 'usage', reason: 'Choose exactly one mode.' };
  const unknown = flags.filter((flag) => !modes.includes(flag) && !flag.startsWith('--max-sends='));
  if (unknown.length > 0) return { mode: 'usage', reason: `Unknown option ${unknown[0].split('=')[0]}.` };
  const mode = modes[0];
  const cap = flags.find((flag) => flag.startsWith('--max-sends='));
  if (cap && mode !== '--only-test' && mode !== '--send-mass') {
    return { mode: 'usage', reason: '--max-sends works only with --only-test or --send-mass.' };
  }
  if (mode === '--check') return { mode: 'check' };
  if (mode === '--status') return { mode: 'status' };
  if (mode === '--schema') return { mode: 'schema' };
  if (mode === '--daemon') return { mode: 'daemon' };
  if (mode === '--healthcheck') return { mode: 'healthcheck' };
  let maxSends: number | undefined;
  if (cap) {
    const value = cap.slice('--max-sends='.length);
    if (!/^[1-9]\d{0,6}$/.test(value)) return { mode: 'usage', reason: '--max-sends must be a positive integer.' };
    maxSends = Number(value);
  }
  return { mode: 'send', kind: mode === '--only-test' ? 'test' : undefined, maxSends };
}

export const DEFAULT_HEARTBEAT_FILE = '/tmp/gnh-broadcast-worker.heartbeat';

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid integer ${JSON.stringify(value)}; expected ${min}-${max}`);
  }
  return parsed;
}

/** Daemon settings from env. Mass sending is off unless BROADCAST_MASS_ENABLED is exactly "true". */
export function readDaemonSettings(
  env: NodeJS.ProcessEnv,
  miniAppUrl: string | null
): Omit<DaemonSettings, 'onHeartbeat'> & { heartbeatFile: string } {
  const ageHours = intEnv(env.BROADCAST_MAX_QUEUED_AGE_HOURS, 24, 0, 24 * 30);
  return {
    miniAppUrl,
    massEnabled: env.BROADCAST_MASS_ENABLED === 'true',
    pollMs: intEnv(env.BROADCAST_POLL_SECONDS, 5, 1, 300) * 1000,
    maxQueuedAgeHours: ageHours === 0 ? null : ageHours,
    batchSize: intEnv(env.BROADCAST_BATCH_SIZE, 500, 1, 100_000),
    minIntervalMs: intEnv(env.BROADCAST_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 50, 10_000),
    heartbeatFile: env.BROADCAST_HEARTBEAT_FILE?.trim() || DEFAULT_HEARTBEAT_FILE,
  };
}

export function heartbeatIsFresh(file: string, maxAgeMs: number, now = Date.now()): boolean {
  try {
    return now - fs.statSync(file).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const file = path.resolve(entry);
  return file.endsWith(`${path.sep}broadcastWorkerMain.ts`) || file.endsWith(`${path.sep}broadcastWorkerMain.js`);
}

async function connectStore(databaseUrl: string): Promise<BroadcastStore> {
  if (!databaseUrl) {
    console.error('[broadcast] DATABASE_URL is required; no messages sent');
    process.exit(1);
  }
  const store = await resolveBroadcastStore(databaseUrl);
  if (!store) {
    console.error('[broadcast] database is unavailable; no messages sent');
    process.exit(1);
  }
  return store;
}

async function openStore(databaseUrl: string): Promise<BroadcastStore> {
  const store = await connectStore(databaseUrl);
  if (!(await store.tablesReady())) {
    console.error('[broadcast] tables or button columns are missing (apply migrations 002 and 003); no messages sent');
    process.exit(1);
  }
  return store;
}

async function audienceSize(store: BroadcastStore, audience: 'ads' | 'notify'): Promise<number | string> {
  try {
    return await store.countRecipients(audience);
  } catch {
    return 'unreadable';
  }
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseWorkerArgs(process.argv.slice(2));
  if (args.mode === 'usage') {
    console.error(`[broadcast] ${args.reason}\n${USAGE}`);
    process.exit(1);
  }

  if (args.mode === 'healthcheck') {
    const file = process.env.BROADCAST_HEARTBEAT_FILE?.trim() || DEFAULT_HEARTBEAT_FILE;
    const fresh = heartbeatIsFresh(file, 3 * 60_000);
    if (!fresh) console.error('[broadcast] heartbeat is stale or missing');
    process.exit(fresh ? 0 : 1);
  }

  const config = readConfig(process.env);

  if (args.mode === 'schema') {
    const store = await connectStore(config.databaseUrl);
    const problems = await store.schemaProblems();
    if (problems.length === 0) console.log('[broadcast] schema: migrations 002 and 003 are applied, privileges are enough (read-only check)');
    else console.error('[broadcast] schema problems (read-only check, nothing changed)', { problems });
    await closeDb();
    process.exit(problems.length === 0 ? 0 : 1);
  }

  if (args.mode === 'status') {
    const store = await openStore(config.databaseUrl);
    const eligibleAdsRecipients = await audienceSize(store, 'ads');
    console.log('[broadcast] status (read-only, nothing sent; no Telegram IDs printed)', {
      eligibleAdsRecipients,
      note:
        'eligibleAdsRecipients = contacts with ads_opt_in, without /unsubscribe, without blocked_at. ' +
        'This is the exact count allowed for the WEB-launch ads announcement.',
      informationalAudience: await audienceSize(store, 'notify'),
      queuedTest: await store.queueDepth('test'),
      queuedMass: await store.queueDepth('mass'),
    });
    await closeDb();
    return;
  }

  if (!config.botToken) {
    console.error('[broadcast] Missing required env BOT_TOKEN');
    process.exit(1);
  }
  if (args.mode === 'check') {
    const result = await checkTelegramApi(config.botToken);
    if (!result.ok) {
      console.error('[broadcast] Telegram API is unreachable; no messages sent');
      process.exit(1);
    }
    console.log(`[broadcast] Telegram API is reachable as @${result.username}; no messages sent`);
    return;
  }

  if (args.mode === 'daemon') {
    const settings = readDaemonSettings(process.env, usableHttpsUrl(config.miniAppUrl));
    const store = await connectStore(config.databaseUrl);
    const telegram = await checkTelegramApi(config.botToken);
    if (telegram.ok) console.log(`[broadcast] Telegram API is reachable as @${telegram.username}`);
    else console.error('[broadcast] Telegram getMe failed (no route to api.telegram.org or BOT_TOKEN rejected); the daemon keeps the queue and retries');
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    let lastBeat = 0;
    const beat = () => {
      lastBeat = Date.now();
      try {
        fs.writeFileSync(settings.heartbeatFile, String(lastBeat));
      } catch {
        // Outside the container the directory may not exist; the health check is then unavailable.
      }
    };
    await runBroadcastDaemon(
      store,
      createTelegramSender(config.botToken),
      {
        ...settings,
        onHeartbeat: beat,
        onProgress: () => {
          if (Date.now() - lastBeat >= 10_000) beat();
        },
      },
      { shouldStop: () => stopping }
    );
    await closeDb();
    return;
  }

  const store = await openStore(config.databaseUrl);
  console.log('[broadcast] worker started', {
    kind: args.kind ?? 'test+mass',
    maxSends: args.maxSends ?? 'unlimited',
    note: 'deliveries are marked sent only after Telegram returns message_id',
  });
  const report = await runBroadcastWorker(store, createTelegramSender(config.botToken), {
    miniAppUrl: usableHttpsUrl(config.miniAppUrl),
    kind: args.kind,
    maxSends: args.maxSends,
  });
  console.log('[broadcast] worker finished', report);
  await closeDb();
}

if (isDirectRun()) {
  void main().catch(async (error) => {
    console.error('[broadcast] worker failed', redact(error));
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
}
