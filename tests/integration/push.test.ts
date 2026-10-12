import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { openMemoryDb } from '../../src/server/db.js';
import { PushService } from '../../src/server/push.js';
import { SecretBox } from '../../src/server/secrets.js';
import { AlertService } from '../../src/server/alerts.js';
import { DEFAULT_APP_SETTINGS } from '../../src/server/settings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elf-push-'));
const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** Local MOCK push service (stands in for Apple / Google push endpoints). */
async function mockPushService(status = 201) {
  const received: { headers: http.IncomingHttpHeaders; body: Buffer; url: string }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? '' });
      res.writeHead(status).end();
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, received };
}

/** A real P-256 key pair, as a browser creates for a subscription. */
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

describe('Web Push', () => {
  it('persists VAPID keys, encrypts + signs payloads and delivers them to the push endpoint', async () => {
    const dir = tmp();
    const db = openMemoryDb();
    const push = new PushService(db, dir, fetch, {});
    expect(push.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(new PushService(db, dir, fetch, {}).publicKey).toBe(push.publicKey); // same keys after restart
    const mock = await mockPushService(201);
    push.subscribe({ endpoint: `${mock.url}/device-1`, keys: browserKeys() }, 'test-agent');
    const statuses = await push.broadcast({ title: 'ENTRY READY', body: 'BTCUSD 15m long' });
    expect(statuses).toEqual([201]);
    const req = mock.received[0];
    expect(req.url).toBe('/device-1');
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(String(req.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(req.headers.ttl).toBe('3600');
    expect(req.body.includes(Buffer.from('ENTRY READY'))).toBe(false); // payload is encrypted
    expect(req.body.length).toBeGreaterThan(80);
  });

  it('removes subscriptions the push service reports as gone (410)', async () => {
    const db = openMemoryDb();
    const push = new PushService(db, tmp(), fetch, {});
    const mock = await mockPushService(410);
    push.subscribe({ endpoint: `${mock.url}/old`, keys: browserKeys() }, null);
    expect(push.list()).toHaveLength(1);
    await push.broadcast({ title: 'x' });
    expect(push.list()).toHaveLength(0);
  });

  it('alerts go to push only when the push preference is on', async () => {
    const db = openMemoryDb();
    const push = new PushService(db, tmp(), fetch, {});
    const mock = await mockPushService(201);
    push.subscribe({ endpoint: `${mock.url}/d`, keys: browserKeys() }, null);
    let prefs = { ...DEFAULT_APP_SETTINGS.alerts, push: false } as any;
    const alerts = new AlertService(db, () => prefs);
    alerts.addChannel(push);
    const base = { category: 'entry' as const, type: 'entry_ready', provider: 'binanceus', symbol: 'BTCUSD', timeframe: '15m', direction: 'long', title: 't', message: 'm', data: null, candleTime: 1 };
    alerts.record({ ...base, eventKey: 'k1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.received).toHaveLength(0);
    prefs = { ...prefs, push: true };
    alerts.record({ ...base, eventKey: 'k2' });
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.received).toHaveLength(1);
  });

  it('rejects malformed subscriptions', () => {
    const push = new PushService(openMemoryDb(), tmp(), fetch, {});
    expect(() => push.subscribe({ endpoint: 'javascript:x', keys: { p256dh: 'a', auth: 'b' } }, null)).toThrow();
  });
});

describe('Deployment hardening', () => {
  it('accepts a host-generated random secret as the encryption key', () => {
    const generated = crypto.randomBytes(32).toString('base64'); // e.g. Render generateValue
    const a = new SecretBox(tmp(), generated);
    const b = new SecretBox(tmp(), generated);
    expect(b.decrypt(a.encrypt('token'))).toBe('token');
    expect(() => new SecretBox(tmp(), 'short')).toThrow();
  });

  it('refuses to start in production without a password', () => {
    const r = spawnSync('npx', ['tsx', 'src/server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', ELF_APP_PASSWORD: '', ELF_ALLOW_NO_PASSWORD: '', ELF_PORT: '0', ELF_DATA_DIR: tmp() }, encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to start in production without ELF_APP_PASSWORD/);
  });
});
