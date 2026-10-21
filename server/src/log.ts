const BOT_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g;
const TELEGRAM_API = /https?:\/\/api\.telegram\.org\/bot[^\s'"]+/gi;
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s'"]+/gi;
const USERINFO = /\/\/([^/\s:@]+):([^/\s@]+)@/g;

export function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text
    .replace(TELEGRAM_API, 'https://api.telegram.org/bot[redacted]')
    .replace(BOT_TOKEN, '[redacted-bot-token]')
    .replace(DATABASE_URL, '[redacted-database-url]')
    .replace(USERINFO, '//$1:[redacted]@')
    .replace(/secret_token(["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]+/gi, 'secret_token$1[redacted]');
}
