import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'server', 'data', 'bot.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema(db);
  }
  return db;
}

export type SubscriptionStatus = 'active' | 'expired';

export interface UserRow {
  user_id: number;
  subscription_expires_at: string | null;
  subscription_status: SubscriptionStatus;
  subscription_expiry_notified_at: string | null;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      subscription_expires_at TEXT,
      subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'expired')),
      subscription_expiry_notified_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_subscription_check
      ON users(subscription_status, subscription_expires_at)
      WHERE subscription_status = 'active' AND subscription_expires_at IS NOT NULL;
  `);
}

/**
 * Ensure user exists; does not overwrite existing subscription. Use setSubscription when user pays.
 */
export function ensureUser(userId: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO users (user_id, subscription_expires_at, subscription_status, updated_at)
       VALUES (?, NULL, 'active', ?)
       ON CONFLICT(user_id) DO NOTHING`
    )
    .run(userId, now);
}

/**
 * Set subscription (e.g. after payment). Pass null expiresAt for no expiry.
 */
export function setSubscription(userId: number, subscriptionExpiresAt: string | null, subscriptionStatus: SubscriptionStatus = 'active'): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO users (user_id, subscription_expires_at, subscription_status, subscription_expiry_notified_at, updated_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         subscription_expires_at = excluded.subscription_expires_at,
         subscription_status = excluded.subscription_status,
         subscription_expiry_notified_at = NULL,
         updated_at = excluded.updated_at`
    )
    .run(userId, subscriptionExpiresAt, subscriptionStatus, now);
}

/**
 * Get users that are still active but subscription_expires_at is in the past and not yet notified.
 */
export function getExpiredActiveUsers(): UserRow[] {
  const database = getDb();
  const now = new Date().toISOString();
  const rows = database
    .prepare(
      `SELECT user_id, subscription_expires_at, subscription_status, subscription_expiry_notified_at
       FROM users
       WHERE subscription_status = 'active'
         AND subscription_expires_at IS NOT NULL
         AND subscription_expires_at < ?
         AND subscription_expiry_notified_at IS NULL`
    )
    .all(now) as UserRow[];
  return rows;
}

/**
 * Mark user as expired and set notification timestamp so we don't notify again.
 */
export function markExpiredAndNotified(userId: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE users
       SET subscription_status = 'expired', subscription_expiry_notified_at = ?, updated_at = ?
       WHERE user_id = ?`
    )
    .run(now, now, userId);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
