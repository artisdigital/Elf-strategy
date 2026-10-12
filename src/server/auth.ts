// Optional single-user password protection. Enabled when ELF_APP_PASSWORD is set.
// Session cookie = "<expiry>.<HMAC(expiry)>" (stateless; HttpOnly; SameSite=Strict).

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const COOKIE = 'elf_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

export class Auth {
  private readonly key: Buffer | null;
  private attempts = new Map<string, { n: number; since: number }>();

  constructor(private readonly password: string | undefined = process.env.ELF_APP_PASSWORD, secretSalt = 'elf') {
    this.key = password ? crypto.createHash('sha256').update(`${secretSalt}:${password}`).digest() : null;
  }

  get enabled() {
    return !!this.key;
  }

  private sign(exp: number) {
    return crypto.createHmac('sha256', this.key!).update(String(exp)).digest('base64url');
  }

  private valid(token: string | undefined): boolean {
    if (!this.key) return true;
    if (!token) return false;
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
    const expect = this.sign(exp);
    return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  }

  private cookie(req: Request): string | undefined {
    const raw = req.headers.cookie ?? '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return undefined;
  }

  isAuthed(req: Request) {
    return this.valid(this.cookie(req));
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!this.key) return next();
    const p = req.path;
    if (p === '/health' || p.startsWith('/auth/')) return next();
    if (this.isAuthed(req)) return next();
    res.status(401).json({ error: 'Login required' });
  };

  login = (req: Request, res: Response) => {
    if (!this.key) return res.json({ ok: true, enabled: false });
    const ip = req.ip ?? 'unknown';
    const a = this.attempts.get(ip) ?? { n: 0, since: Date.now() };
    if (Date.now() - a.since > 60_000) (a.n = 0), (a.since = Date.now());
    if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
    a.n++;
    this.attempts.set(ip, a);
    const given = String(req.body?.password ?? '');
    const h1 = crypto.createHash('sha256').update(given).digest();
    const h2 = crypto.createHash('sha256').update(this.password!).digest();
    if (!crypto.timingSafeEqual(h1, h2)) return res.status(401).json({ error: 'Incorrect password' });
    const exp = Date.now() + TTL_MS;
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${this.sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  };

  logout = (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  };
}
