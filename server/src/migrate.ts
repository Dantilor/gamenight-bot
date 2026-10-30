import { config as loadEnv } from 'dotenv';
import { closeDb, getConnection, initDb } from './db.js';
import { redact } from './log.js';
import fs from 'node:fs';
import path from 'node:path';
import { assertMigrationIsSafe, migrationStatements, readMigrationSql } from './migrationSql.js';

function migrationPaths(cwd = process.cwd()): string[] {
  const directory = path.join(cwd, 'server', 'db', 'migrations');
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(directory, name));
}

async function main(): Promise<void> {
  loadEnv();
  const files = migrationPaths();
  const scripts = files.map((file) => fs.readFileSync(file, 'utf8'));
  for (const sql of scripts) assertMigrationIsSafe(sql);
  if (!readMigrationSql()) {
    console.error('[migrate] notice migration is missing');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }
  await initDb(process.env);
  try {
    const connection = getConnection();
    if (!connection) throw new Error('database is not configured');
    let statements = 0;
    for (const sql of scripts) {
      const current = migrationStatements(sql);
      await connection.withTransaction(async (query) => {
        for (const statement of current) await query(statement);
      });
      statements += current.length;
    }
    console.log('[migrate] bot tables are ready', { statements });
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && process.argv[1].includes('migrate')) {
  void main().catch((error) => {
    console.error('[migrate] failed', redact(error));
    process.exit(1);
  });
}
