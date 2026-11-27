import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveBroadcastStore, type BroadcastStore, type CampaignKind } from './broadcastStore.js';
import { checkTelegramApi, runBroadcastWorker, createTelegramSender } from './broadcastWorker.js';
import { readConfig } from './config.js';
import { closeDb } from './db.js';
import { redact } from './log.js';
import { usableHttpsUrl } from './webhookReply.js';

export type WorkerArgs =
  | { mode: 'check' }
  | { mode: 'status' }
  | { mode: 'send'; kind: CampaignKind | undefined; maxSends: number | undefined }
  | { mode: 'usage'; reason: string };

export const USAGE =
  'Usage: npm run broadcast-worker -- <mode>\n' +
  '  --check             reach Telegram with getMe only; sends nothing\n' +
  '  --status            read-only: eligible ads recipients, informational audience, queue depth; sends nothing\n' +
  '  --only-test         send queued TEST campaigns only; a mass queue is never touched\n' +
  '  --send-mass         send test and mass campaigns (use only after the owner approves)\n' +
  '  --max-sends=N       optional cap on messages in this run';

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const modes = flags.filter((flag) => ['--check', '--status', '--only-test', '--send-mass'].includes(flag));
  if (modes.length !== 1) return { mode: 'usage', reason: 'Choose exactly one mode.' };
  const unknown = flags.filter((flag) => !modes.includes(flag) && !flag.startsWith('--max-sends='));
  if (unknown.length > 0) return { mode: 'usage', reason: `Unknown option ${unknown[0].split('=')[0]}.` };
  if (modes[0] === '--check') return { mode: 'check' };
  if (modes[0] === '--status') return { mode: 'status' };
  let maxSends: number | undefined;
  const cap = flags.find((flag) => flag.startsWith('--max-sends='));
  if (cap) {
    const value = cap.slice('--max-sends='.length);
    if (!/^[1-9]\d{0,6}$/.test(value)) return { mode: 'usage', reason: '--max-sends must be a positive integer.' };
    maxSends = Number(value);
  }
  return { mode: 'send', kind: modes[0] === '--only-test' ? 'test' : undefined, maxSends };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const file = path.resolve(entry);
  return file.endsWith(`${path.sep}broadcastWorkerMain.ts`) || file.endsWith(`${path.sep}broadcastWorkerMain.js`);
}

async function openStore(databaseUrl: string): Promise<BroadcastStore> {
  if (!databaseUrl) {
    console.error('[broadcast] DATABASE_URL is required; no messages sent');
    process.exit(1);
  }
  const store = await resolveBroadcastStore(databaseUrl);
  if (!store || !(await store.tablesReady())) {
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
  const config = readConfig(process.env);

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
