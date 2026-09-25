/**
 * Client for the colony channel (see /chat). One socket per tab, opened the
 * first time the panel is opened, kept alive across page navigations because
 * the panel is `transition:persist`ed. All message text goes in via
 * textContent: nothing a visitor types is ever parsed as HTML.
 */
import { fnv1a } from '../sigil';

type Msg = { id: number; name: string; text: string; ts: number };
type ServerFrame =
  | { t: 'welcome'; you: { name: string }; history: Msg[]; online: number }
  | ({ t: 'msg' } & Msg)
  | { t: 'presence'; online: number }
  | { t: 'system' | 'error'; text: string }
  | { t: 'pong' };

const INKS = ['#c6ff3d', '#7d8cff', '#9a6bff', '#ff4b1f', '#ece5d3', '#5ee6c9', '#ffb23d'];
const inkFor = (name: string) => INKS[fnv1a(name) % INKS.length];
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export function mountChat() {
  const root = document.querySelector<HTMLElement>('[data-chat]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const base = root.dataset.url ?? '';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const panel = $('[data-chat-panel]');
  const toggle = $<HTMLButtonElement>('[data-chat-toggle]');
  const log = $<HTMLOListElement>('[data-chat-log]');
  const input = $<HTMLInputElement>('[data-chat-input]');
  const me = $<HTMLButtonElement>('[data-chat-me]');
  const status = $('[data-chat-status]');
  const onlineEl = $('[data-chat-online]');
  const unreadEl = $('[data-chat-unread]');

  let ws: WebSocket | null = null;
  let name = store.get('chat:name') ?? '';
  let backoff = 1000;
  let unread = 0;
  let pingTimer = 0;
  const seen = new Set<number>();

  const setOnline = (n: number) => {
    onlineEl.hidden = n < 1;
    onlineEl.textContent = `${n} online`;
    root.classList.toggle('is-live', n > 0);
  };
  const setStatus = (s: string, cls = '') => {
    status.textContent = s;
    status.className = `chat__status ${cls}`;
  };

  const line = (m: Msg | { system: string; error?: boolean }) => {
    const li = document.createElement('li');
    if ('system' in m) {
      li.className = `chat__sys${m.error ? ' is-error' : ''}`;
      li.textContent = m.system;
    } else {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      li.className = `chat__msg${m.name === name ? ' is-me' : ''}`;
      const who = document.createElement('b');
      who.textContent = m.name;
      who.style.color = inkFor(m.name);
      const time = document.createElement('time');
      const d = new Date(m.ts);
      time.dateTime = d.toISOString();
      time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const text = document.createElement('span');
      text.textContent = m.text;
      li.append(who, time, text);
      if (panel.hidden && m.name !== name) {
        unread++;
        unreadEl.hidden = false;
        unreadEl.textContent = String(unread);
      }
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.append(li);
    while (log.children.length > 300) log.firstElementChild!.remove();
    if (atBottom || li.classList.contains('is-me')) log.scrollTop = log.scrollHeight;
  };

  const connect = () => {
    if (!base) {
      setStatus('offline', 'is-off');
      line({ system: 'The channel isn’t switched on yet. Check back soon.' });
      return;
    }
    if (ws && ws.readyState <= 1) return;
    setStatus('connecting…');
    ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    ws.addEventListener('open', () => {
      backoff = 1000;
      setStatus('live', 'is-live');
      ws!.send(JSON.stringify({ t: 'hello', name }));
      clearInterval(pingTimer);
      pingTimer = window.setInterval(() => ws?.readyState === 1 && ws.send('{"t":"ping"}'), 30_000);
    });
    ws.addEventListener('message', (ev) => {
      let f: ServerFrame;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (f.t) {
        case 'welcome':
          name = f.you.name;
          store.set('chat:name', name);
          me.textContent = name;
          me.style.color = inkFor(name);
          f.history.forEach(line);
          setOnline(f.online);
          break;
        case 'msg':
          line(f);
          break;
        case 'presence':
          setOnline(f.online);
          break;
        case 'system':
          line({ system: f.text });
          break;
        case 'error':
          line({ system: f.text, error: true });
          break;
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      setStatus('reconnecting…', 'is-off');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };

  const open = (show: boolean = panel.hidden === true) => {
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    root.classList.toggle('is-open', show);
    if (show) {
      unread = 0;
      unreadEl.hidden = true;
      connect();
      input.focus();
      log.scrollTop = log.scrollHeight;
    }
  };

  toggle.addEventListener('click', () => open());
  $('[data-chat-close]').addEventListener('click', () => open(false));
  addEventListener('chat:open', () => open(true));
  panel.addEventListener('keydown', (e) => e.key === 'Escape' && (open(false), toggle.focus()));
  $<HTMLFormElement>('[data-chat-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || ws?.readyState !== 1) return;
    ws.send(JSON.stringify({ t: 'msg', text }));
    input.value = '';
  });
  me.addEventListener('click', () => {
    const next = prompt('Your handle (2–24 characters):', name)?.trim();
    if (next && next !== name && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'name', name: next }));
  });

  // a cheap presence peek for the chip, without opening a socket
  if (base) {
    fetch(`${base}/presence`)
      .then((r) => r.json())
      .then((d: { online: number }) => setOnline(d.online))
      .catch(() => {});
  }
}
