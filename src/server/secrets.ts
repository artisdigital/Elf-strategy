// Provider credentials are encrypted at rest with AES-256-GCM and never sent to the client.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecretBox {
  private readonly key: Buffer;

  constructor(dataDir: string, envKey = process.env.ELF_SECRET_KEY) {
    if (envKey && envKey.trim()) {
      const v = envKey.trim();
      // 64 hex chars are used directly; any other secret (e.g. a host-generated random string, ≥ 32 chars) is hashed to 32 bytes.
      if (/^[0-9a-fA-F]{64}$/.test(v)) this.key = Buffer.from(v, 'hex');
      else if (v.length >= 32) this.key = crypto.createHash('sha256').update(v).digest();
      else throw new Error('ELF_SECRET_KEY must be 64 hex characters or a random secret of at least 32 characters');
      return;
    }
    const file = path.join(dataDir, 'secret.key');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(file, this.key.toString('hex'), { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error(`Invalid key file ${file}`);
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(blob: string): string {
    const [v, iv, tag, data] = blob.split(':');
    if (v !== 'v1') throw new Error('Unknown secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Redact anything that looks like a credential before it reaches logs or error messages. */
export function redact(message: string, secrets: (string | undefined | null)[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/(token|key|secret|authorization)=([^&\s]+)/gi, '$1=***');
}
