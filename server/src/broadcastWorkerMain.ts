import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveBroadcastStore } from './broadcastStore.js';
import { checkTelegramApi, runBroadcastWorker, createTelegramSender } from './broadcastWorker.js';
import { readConfig } from './config.js';
import { closeDb } from './db.js';
import { redact } from './log.js';
import { usableHttpsUrl } from './webhookReply.js';

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const file = path.resolve(entry);
  return file.endsWith(`${path.sep}broadcastWorkerMain.ts`) || file.endsWith(`${path.sep}broadcastWorkerMain.js`);
}

async function main(): Promise<void> {
  loadEnv();
  const config = readConfig(process.env);
  if (!config.botToken) {
    console.error('[broadcast] Missing required env BOT_TOKEN');
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    const result = await checkTelegramApi(config.botToken);
    if (!result.ok) {
      console.error('[broadcast] Telegram API is unreachable; no messages sent');
      process.exit(1);
    }
    console.log(`[broadcast] Telegram API is reachable as @${result.username}; no messages sent`);
    return;
  }
  if (!config.databaseUrl) {
    console.error('[broadcast] DATABASE_URL is required; no messages sent');
    process.exit(1);
  }
  const store = await resolveBroadcastStore(config.databaseUrl);
  if (!store || !(await store.tablesReady())) {
    console.error('[broadcast] tables are missing; no messages sent');
    process.exit(1);
  }
  console.log('[broadcast] worker started; deliveries are marked sent only after Telegram returns message_id');
  const report = await runBroadcastWorker(store, createTelegramSender(config.botToken), {
    buttonUrl: usableHttpsUrl(config.miniAppUrl),
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
