import crypto from 'node:crypto';
import { env } from './env';

/**
 * Printer LAN access codes are stored encrypted so a database dump doesn't hand
 * over control of the hardware. AES-256-GCM, key derived from APP_SECRET.
 */

const ALGO = 'aes-256-gcm';

function key(): Buffer {
  // APP_SECRET is arbitrary text; hash it to a fixed 32-byte key.
  return crypto.createHash('sha256').update(env.appSecret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Never send the real value to the browser. */
export function maskSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  return '••••••••';
}
