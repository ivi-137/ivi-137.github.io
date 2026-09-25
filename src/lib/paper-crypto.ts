/**
 * The encrypted-download format shared by /paper/ (decrypt), /paper/update/ (encrypt in the
 * browser) and scripts/encrypt-paper.mjs (encrypt from the command line):
 *   "GPE1" · PBKDF2-SHA-256 iterations (u32, big-endian) · salt (16) · iv (12) · AES-256-GCM ciphertext.
 * A wrong password fails GCM's authentication check.
 */
const MAGIC = 'GPE1';
const HEAD = 4 + 4 + 16 + 12;
export const ITERATIONS = 600_000;

async function deriveKey(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

export async function decrypt(blob: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(blob);
  if (bytes.length < HEAD || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('format');
  const iterations = new DataView(blob).getUint32(4);
  const key = await deriveKey(password, bytes.slice(8, 24), iterations, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(24, 36) }, key, bytes.subarray(HEAD));
}

export async function encrypt(plain: ArrayBuffer, password: string, iterations = ITERATIONS): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(HEAD + cipher.length);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, iterations);
  out.set(salt, 8);
  out.set(iv, 24);
  out.set(cipher, HEAD);
  return out;
}
