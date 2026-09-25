import { navigate } from 'astro:transitions/client';
import type { Life } from '../life/engine';

export const go = (url: string) => {
  if (/^https?:\/\//.test(url) && !url.startsWith(location.origin)) window.open(url, '_blank', 'noopener');
  else navigate(url);
};

export const life = (): Life | undefined => (window as any).__life;

export function toast(text: string, ms = 4200) {
  const host = document.querySelector('[data-toasts]');
  if (!host) return;
  const el = document.createElement('p');
  el.className = 'toast mono';
  el.textContent = text;
  host.append(el);
  setTimeout(() => el.classList.add('is-out'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

/** Open a <dialog> modally, closing any other open overlay first. */
export function openDialog(sel: string) {
  document.querySelectorAll<HTMLDialogElement>('.overlays dialog[open]').forEach((d) => d.close());
  const d = document.querySelector<HTMLDialogElement>(sel);
  if (d && !d.open) d.showModal();
  return d;
}
