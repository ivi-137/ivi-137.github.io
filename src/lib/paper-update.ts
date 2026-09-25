/**
 * Replace the paper behind /paper/: pick a new PDF, choose the password, and get back the
 * encrypted file to upload to public/paper/ on GitHub. Everything happens in this browser tab;
 * the PDF and the password are never sent anywhere.
 */
import { decrypt, encrypt } from './paper-crypto';

export function mountPaperUpdate() {
  const root = document.querySelector<HTMLElement>('[data-paper-update]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const form = root.querySelector<HTMLFormElement>('form')!;
  const file = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const [pass, again] = root.querySelectorAll<HTMLInputElement>('input[type=password]');
  const button = root.querySelector<HTMLButtonElement>('button')!;
  const status = root.querySelector<HTMLElement>('[data-update-status]')!;
  const next = root.querySelector<HTMLElement>('[data-update-next]')!;
  const save = root.querySelector<HTMLAnchorElement>('[data-update-save]')!;
  const name = root.dataset.name!;
  let url = '';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    next.hidden = true;
    status.textContent = '';
    const pdf = file.files?.[0];
    if (!pdf) return;
    if (pass.value !== again.value) {
      status.textContent = 'The two passwords differ.';
      again.select();
      return;
    }
    const plain = await pdf.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(plain, 0, Math.min(5, plain.byteLength))) !== '%PDF-') {
      status.textContent = 'That file is not a PDF.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Encrypting…';
    try {
      const sealed = await encrypt(plain, pass.value);
      // open it again with the same password before handing it over
      const back = new Uint8Array(await decrypt(sealed.buffer as ArrayBuffer, pass.value));
      const orig = new Uint8Array(plain);
      if (back.length !== orig.length || back.some((b, i) => b !== orig[i])) throw new Error('round trip');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([sealed as BlobPart], { type: 'application/octet-stream' }));
      save.href = url;
      save.download = name;
      save.click();
      const kb = (n: number) => `${Math.round(n / 1024)} KB`;
      status.textContent = `Done: ${pdf.name} (${kb(plain.byteLength)}) → ${name} (${kb(sealed.length)}), checked by decrypting it again.`;
      next.hidden = false;
    } catch {
      status.textContent = 'Encryption failed in this browser. Try an up-to-date Firefox, Chrome or Safari.';
    } finally {
      button.disabled = false;
    }
  });
}
