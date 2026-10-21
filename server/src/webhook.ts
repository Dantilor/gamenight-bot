import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { isValidWebhookSecret } from './config.js';
import { redact } from './log.js';

const UPDATE_KEYS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'message_reaction',
  'message_reaction_count',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
] as const;

export type TelegramUpdate = { update_id: number } & Record<string, unknown>;

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function parseTelegramUpdate(body: unknown): TelegramUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const update = body as Record<string, unknown>;
  if (!Number.isInteger(update.update_id) || (update.update_id as number) < 0) return null;
  if (Object.keys(update).length > 1 && !UPDATE_KEYS.some((key) => update[key] != null)) return null;
  return update as TelegramUpdate;
}

export function webhookSecretFailure(secret: string, header: string | undefined): string | null {
  if (!secret) return null;
  if (!isValidWebhookSecret(secret)) return 'invalid';
  if (!header || !safeEqual(header, secret)) return 'rejected';
  return null;
}

export function logWebhookRejection(reason: string): void {
  console.warn('[webhook] update rejected', { reason: redact(reason) });
}

export function readSecretHeader(req: Request): string | undefined {
  const value = req.get('X-Telegram-Bot-Api-Secret-Token');
  return value === undefined || value === '' ? undefined : value;
}

export function rejectWebhook(res: Response, status: 400 | 401): void {
  if (!res.headersSent) res.status(status).json({ ok: false });
}
