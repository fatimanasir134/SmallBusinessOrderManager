/** Invalid or missing configuration stops the server at startup with a clear message. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadEnv(overrides: Record<string, string>) {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./src/config/env.ts')"],
    {
      cwd: SERVER,
      env: { ...process.env, ...overrides },
      encoding: 'utf8',
    },
  );
  return { code: r.status, stderr: r.stderr };
}

describe('environment validation', () => {
  it('accepts the normal configuration', () => {
    assert.equal(loadEnv({}).code, 0);
  });

  it('refuses invalid settings with a message naming the variable', () => {
    for (const [name, value] of [
      ['DATABASE_URL', 'not-a-url'],
      ['DATABASE_URL', 'mysql://x@localhost/db'],
      ['PORT', '-5'],
      ['LOG_LEVEL', 'loud'],
      ['API_TOKEN', 'short'],
      ['GEMINI_MAX_ATTEMPTS', '99'],
    ]) {
      const r = loadEnv({ [name!]: value! });
      assert.equal(r.code, 1, `${name}=${value} should fail`);
      assert.match(r.stderr, new RegExp(name!), `${name} named in the error`);
    }
  });

  it('treats API_TOKEN "off" (for hosts that require a value) as no token', () => {
    for (const value of ['off', 'OFF', 'none', 'false', 'disabled']) {
      assert.equal(loadEnv({ API_TOKEN: value }).code, 0, `API_TOKEN=${value} should start`);
    }
  });

  it('starts without a Gemini key (AI features report AI_NOT_CONFIGURED instead)', () => {
    assert.equal(loadEnv({ GEMINI_API_KEY: '' }).code, 0);
  });
});
