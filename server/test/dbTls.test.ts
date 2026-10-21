import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { ConnectionOptions } from 'node:tls';
import { resolvePgPoolConfig } from '../src/dbTls.js';

function sslOf(client: pg.Client): ConnectionOptions {
  return client.ssl as ConnectionOptions;
}

test('database TLS keeps certificate verification enabled', () => {
  const resolved = resolvePgPoolConfig({
    DATABASE_URL: 'postgresql://gamenight_bot:s3cret@db.example:5432/gnh_supabase?sslmode=require',
  });
  assert.equal(resolved.ssl.rejectUnauthorized, true);
  assert.equal(resolved.ssl.minVersion, 'TLSv1.2');
  assert.equal(resolved.ssl.servername, 'db.example');
  assert.equal(resolved.summary.user, 'gamenight_bot');
  assert.equal(resolved.summary.database, 'gnh_supabase');
  assert.equal(Object.hasOwn(resolved.summary, 'password'), false);
  assert.equal(resolved.connectionString.includes('sslmode'), false);
  const client = new pg.Client({ connectionString: resolved.connectionString, ssl: resolved.ssl });
  assert.equal(sslOf(client).rejectUnauthorized, true);
});

test('database TLS refuses plaintext and an unverified IP host', () => {
  assert.throws(() => resolvePgPoolConfig({
    DATABASE_URL: 'postgresql://gamenight_bot:s3cret@db.example:5432/gnh_supabase?sslmode=disable',
  }));
  assert.throws(() => resolvePgPoolConfig({
    DATABASE_URL: 'postgresql://gamenight_bot:s3cret@db.example:5432/gnh_supabase',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  }));
  assert.throws(() => resolvePgPoolConfig({
    DATABASE_URL: 'postgresql://gamenight_bot:s3cret@10.0.0.8:5432/gnh_supabase',
  }));
});

test('database TLS strips sslmode=no-verify from the connection URI', () => {
  const resolved = resolvePgPoolConfig({
    DATABASE_URL: 'postgresql://gamenight_bot:s3cret@127.0.0.1:5432/gnh_supabase?sslmode=no-verify',
    DATABASE_TLS_SERVERNAME: 'db.internal',
  });
  assert.equal(resolved.connectionString.includes('sslmode'), false);
  assert.equal(resolved.ssl.rejectUnauthorized, true);
  assert.equal(resolved.ssl.servername, 'db.internal');
  const client = new pg.Client({ connectionString: resolved.connectionString, ssl: resolved.ssl });
  assert.equal(sslOf(client).rejectUnauthorized, true);
});
