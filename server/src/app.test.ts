/**
 * Loads the app the way the server does (routes first). Catches circular-import problems that
 * tests importing modules in a different order would miss. Also checks production web serving.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it('the app and all routes load without import cycles', async () => {
  const { createApp } = await import('./app.js');
  assert.equal(typeof createApp({ webDist: null }), 'function');
});

it('in production it serves the built web app, with client-side routes, next to the API', async () => {
  const { createApp } = await import('./app.js');
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-web-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Order Manager</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');

  const server = createApp({ webDist: dist }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const route of ['/', '/orders/4', '/audit']) {
      const r = await fetch(base + route);
      assert.equal(r.status, 200, route);
      assert.match(await r.text(), /Order Manager/, route);
    }
    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(await asset.text(), 'console.log(1)');
    const api404 = await fetch(`${base}/api/nope`);
    assert.equal(api404.status, 404);
    assert.equal(((await api404.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
