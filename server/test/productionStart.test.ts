import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TOKEN = '123456789:AAFakeTokenForTestsOnly000';

function waitFor(read: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (read()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 8_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

test('built server starts, answers health, and does not touch Telegram', { timeout: 30_000 }, async () => {
  const dist = path.join(process.cwd(), 'dist', 'main.js');
  assert.equal(fs.existsSync(dist), true);
  assert.equal(fs.readFileSync(dist, 'utf8').includes('deleteWebhook'), false);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.BOT_TOKEN = TOKEN;
  env.MINI_APP_URL = 'https://mini.example';
  env.PUBLIC_URL = 'https://bot.example';
  env.API_URL = 'https://api.example';
  env.DATABASE_URL = '';
  env.ENABLE_WEBHOOK_REGISTRATION = 'false';
  env.ENABLE_SUBSCRIPTION_NOTIFICATIONS = 'false';
  env.PORT = '0';
  const child = spawn(process.execPath, [dist], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const ready = await waitFor(
    () => output.includes('[subscription] notifications disabled') && /\[health\] listening on \d+/.test(output),
    15_000
  );
  try {
    assert.equal(ready, true, output);
    const port = Number(output.match(/\[health\] listening on (\d+)/)?.[1]);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ready: true });
    assert.match(output, /registration disabled/);
    assert.match(output, /hero image ready/);
    assert.equal(output.includes('deleteWebhook'), false);
    assert.equal(output.includes('api.telegram.org'), false);
    assert.equal(output.includes('registration succeeded'), false);
    assert.equal(output.includes(TOKEN), false);
  } finally {
    if (child.exitCode === null) await stop(child);
  }
});
