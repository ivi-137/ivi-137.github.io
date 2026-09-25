/*
 * Encrypt a file for a password-protected download page.
 *
 *   PAPER_PASSWORD=… node scripts/encrypt-paper.mjs paper.pdf public/paper/you-need-coherence.pdf.enc
 *
 * The password comes from the environment and is never written anywhere. Same format as src/lib/paper-crypto.ts,
 * which /paper/ decrypts and /paper/update/ can also produce in the browser:
 * "GPE1" · PBKDF2 iterations (u32, big-endian) · salt (16) · iv (12) · AES-256-GCM ciphertext.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [src, dst] = process.argv.slice(2);
const password = process.env.PAPER_PASSWORD;
if (!src || !dst || !password) {
  console.error('usage: PAPER_PASSWORD=… node scripts/encrypt-paper.mjs <in> <out>');
  process.exit(1);
}

const ITERATIONS = 600_000;
const { subtle } = globalThis.crypto;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey(
  { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
  base,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
);
const plain = readFileSync(src);
const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));

const head = new Uint8Array(4 + 4 + 16 + 12);
head.set(new TextEncoder().encode('GPE1'), 0);
new DataView(head.buffer).setUint32(4, ITERATIONS);
head.set(salt, 8);
head.set(iv, 24);

// round trip before writing
const back = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher));
if (back.length !== plain.length || back.some((b, i) => b !== plain[i])) throw new Error('round trip failed');

mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, Buffer.concat([head, cipher]));
console.log(`${src} (${plain.length} bytes) → ${dst} (${head.length + cipher.length} bytes)`);
