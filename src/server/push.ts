// Web Push (VAPID) — real background notifications to installed apps / browsers, sent by
// the server even when the app is closed. iPhone: requires iOS 16.4+ and the app added to
// the Home Screen. Payloads are end-to-end encrypted to the subscribing device.

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { Db } from './db.js';
import type { AlertChannel, AlertRecord } from './alerts.js';

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export class PushService implements AlertChannel {
  name = 'push';
  readonly publicKey: string;
  private readonly privateKey: string;
  private readonly subject: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly fetchFn: typeof fetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const file = path.join(dataDir, 'vapid.json');
    if (env.ELF_VAPID_PUBLIC_KEY && env.ELF_VAPID_PRIVATE_KEY) {
      this.publicKey = env.ELF_VAPID_PUBLIC_KEY;
      this.privateKey = env.ELF_VAPID_PRIVATE_KEY;
    } else if (fs.existsSync(file)) {
      const k = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.publicKey = k.publicKey;
      this.privateKey = k.privateKey;
    } else {
      const k = webpush.generateVAPIDKeys();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
      this.publicKey = k.publicKey;
      this.privateKey = k.privateKey;
    }
    this.subject = env.ELF_VAPID_SUBJECT || 'mailto:elf-app@localhost';
  }

  subscribe(sub: PushSubscriptionJSON, userAgent: string | null) {
    if (!/^https?:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid push subscription');
    this.db
      .prepare('INSERT INTO push_subscriptions (endpoint, keys, user_agent, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, user_agent = excluded.user_agent')
      .run(sub.endpoint, JSON.stringify(sub.keys), userAgent?.slice(0, 200) ?? null, Date.now());
  }

  unsubscribe(endpoint: string) {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
  }

  list(): { endpoint: string; userAgent: string | null; createdAt: number }[] {
    return (this.db.prepare('SELECT endpoint, user_agent, created_at FROM push_subscriptions ORDER BY created_at').all() as any[]).map((r) => ({
      endpoint: r.endpoint,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    }));
  }

  /** Encrypt + sign (web-push) and deliver with fetch. Expired subscriptions (404/410) are removed. */
  async sendTo(sub: PushSubscriptionJSON, payload: object): Promise<{ status: number }> {
    const details = webpush.generateRequestDetails(sub as webpush.PushSubscription, JSON.stringify(payload), {
      vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
      TTL: 3600,
      urgency: 'high',
    } as webpush.RequestOptions);
    const res = await this.fetchFn(details.endpoint, { method: details.method, headers: details.headers as Record<string, string>, body: details.body as BodyInit });
    if (res.status === 404 || res.status === 410) this.unsubscribe(sub.endpoint);
    return { status: res.status };
  }

  async broadcast(payload: object) {
    const rows = this.db.prepare('SELECT endpoint, keys FROM push_subscriptions').all() as any[];
    const results = await Promise.allSettled(rows.map((r) => this.sendTo({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }, payload)));
    return results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
  }

  async send(a: AlertRecord) {
    await this.broadcast({ title: a.title, body: a.message, tag: a.eventKey, url: a.category === 'entry' || a.category === 'confirmation' ? '/' : '/alerts', createdAt: a.createdAt });
  }
}
