import cron, { type ScheduledTask } from 'node-cron';
import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import { getExpiredActiveUsers, markExpiredAndNotified } from './db.js';

const SUBSCRIPTION_EXPIRED_TEXT = `🔔 Ваша подписка завершена.
Доступ к премиум-функциям временно приостановлен.

Продлите подписку, чтобы продолжить пользоваться всеми возможностями без ограничений.`;

const BATCH_SIZE = 10;
const DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process expired subscriptions: mark as expired and send one-time notification.
 * Runs in batches to avoid overwhelming Telegram API and the process.
 */
export async function runSubscriptionExpiryJob(bot: Telegraf): Promise<void> {
  const users = getExpiredActiveUsers();
  if (users.length === 0) return;

  console.log('[subscription] processing', users.length, 'expired subscription(s)');

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (user) => {
        try {
          markExpiredAndNotified(user.user_id);
          await bot.telegram.sendMessage(user.user_id, SUBSCRIPTION_EXPIRED_TEXT, {
            ...Markup.inlineKeyboard([Markup.button.callback('Продлить подписку', 'renew_subscription')]),
          });
        } catch (err) {
          console.error('[subscription] failed to notify user', user.user_id, err);
          // User still marked as expired so we won't retry forever; consider logging for manual retry
        }
      })
    );
    if (i + BATCH_SIZE < users.length) await sleep(DELAY_MS);
  }
}

/**
 * Schedule hourly subscription expiry check. Uses noOverlap to avoid concurrent runs.
 */
export function startSubscriptionScheduler(bot: Telegraf): ScheduledTask {
  const task = cron.schedule(
    '0 * * * *',
    async () => {
      try {
        await runSubscriptionExpiryJob(bot);
      } catch (err) {
        console.error('[subscription] scheduler error', err);
      }
    },
    { timezone: 'UTC', noOverlap: true }
  );
  console.log('[subscription] hourly scheduler started');
  return task;
}
