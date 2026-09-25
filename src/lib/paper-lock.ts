/**
 * Password-protected download: fetch the encrypted file, derive the key from the password with
 * PBKDF2, decrypt with AES-GCM in the browser, and hand the result to the reader. The password
 * never leaves the page; a wrong one fails GCM's authentication check.
 * File layout (scripts/encrypt-paper.mjs): "GPE1" · iterations u32 BE · salt 16 · iv 12 · ciphertext.
 */
async function decrypt(blob: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(blob);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'GPE1') throw new Error('format');
  const iterations = new DataView(blob).getUint32(4);
  const salt = bytes.slice(8, 24);
  const iv = bytes.slice(24, 36);
  const { subtle } = crypto;
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(36));
}

export function mountPaperLock() {
  const root = document.querySelector<HTMLElement>('[data-paper-lock]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const form = root.querySelector<HTMLFormElement>('form')!;
  const input = root.querySelector<HTMLInputElement>('input[type=password]')!;
  const button = root.querySelector<HTMLButtonElement>('button')!;
  const status = root.querySelector<HTMLElement>('[data-paper-status]')!;
  const links = root.querySelector<HTMLElement>('[data-paper-links]')!;
  const src = root.dataset.src!;
  const name = root.dataset.name!;
  let cipher: Promise<ArrayBuffer> | null = null;
  let url = '';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) return;
    button.disabled = true;
    status.textContent = 'Unlocking…';
    try {
      cipher ??= fetch(src).then((r) => {
        if (!r.ok) throw new Error('fetch');
        return r.arrayBuffer();
      });
      const plain = await decrypt(await cipher, input.value);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([plain], { type: 'application/pdf' }));
      for (const a of links.querySelectorAll<HTMLAnchorElement>('a')) a.href = url;
      links.querySelector<HTMLAnchorElement>('[data-paper-download]')!.download = name;
      links.hidden = false;
      status.textContent = 'Unlocked. The download has started.';
      links.querySelector<HTMLAnchorElement>('[data-paper-download]')!.click();
      input.value = '';
    } catch (err) {
      if ((err as Error).message === 'fetch') {
        cipher = null;
        status.textContent = 'The file could not be loaded. Check your connection and try again.';
      } else {
        status.textContent = 'Wrong password.';
        input.select();
      }
    } finally {
      button.disabled = false;
    }
  });
}
