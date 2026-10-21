import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_FILE = path.join('server', 'db', 'migrations', '001_bot_subscription_expiry_notices.sql');

export function migrationPath(cwd = process.cwd()): string {
  return path.join(cwd, MIGRATION_FILE);
}

export function readMigrationSql(cwd = process.cwd()): string {
  return fs.readFileSync(migrationPath(cwd), 'utf8');
}

export function migrationStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function executableSql(sql: string): string {
  return migrationStatements(sql).join('\n').toLowerCase();
}

export function assertMigrationIsSafe(sql: string): void {
  const executable = executableSql(sql);
  const forbidden = ['subscriptions', 'payments', 'drop table', 'delete from', 'truncate', 'update '];
  for (const token of forbidden) {
    if (executable.includes(token)) {
      throw new Error(`migration refused because it contains "${token.trim()}"`);
    }
  }
}
