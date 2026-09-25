/**
 * The colony channel: one live chat room for gpojani.me.
 *
 * A single Durable Object holds every connection (WebSocket Hibernation API,
 * so an idle room costs nothing) and the last messages in SQLite.
 *
 *   GET    /ws        → WebSocket upgrade (origin-checked)
 *   GET    /presence  → { online }
 *   DELETE /history   → wipe history (Authorization: Bearer $ADMIN_TOKEN)
 *
 * Protocol (JSON text frames)
 *   client → { t: "hello", name? } | { t: "msg", text } | { t: "name", name } | { t: "ping" }
 *   server → { t: "welcome", you, history, online } | { t: "msg", ...Message }
 *            { t: "presence", online } | { t: "system", text } | { t: "error", text } | { t: "pong" }
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
  ADMIN_TOKEN?: string;
}

type Message = {
  id: number;
  name: string;
  text: string;
  ts: number;
};

interface Attachment {
  name: string;
  tokens: number;
  refill: number;
}

const HISTORY_SEND = 60;
const HISTORY_KEEP = 300;
const MAX_TEXT = 500;
const BUCKET = 5; // messages
const REFILL_MS = 2500; // one token per 2.5 s

const HANDLE = /^[\p{L}\p{N} ._-]{2,24}$/u;
const PREFIXES = ['glider', 'acorn', 'pulsar', 'blinker', 'toad', 'beehive', 'loaf', 'spaceship', 'gun', 'diehard'];

const cleanText = (s: unknown) =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
        .trim()
        .slice(0, MAX_TEXT)
    : '';
const cleanName = (s: unknown) => {
  const n = cleanText(s).replace(/\s+/g, ' ').slice(0, 24);
  return HANDLE.test(n) ? n : null;
};
const randomHandle = () => {
  const hex = crypto.getRandomValues(new Uint8Array(2));
  return `${PREFIXES[hex[0] % PREFIXES.length]}-${hex[1].toString(16).toUpperCase().padStart(2, '0')}`;
};

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`);
    });
    // answered by the runtime without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name: randomHandle(), tokens: BUCKET, refill: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  online(except?: WebSocket) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === WebSocket.OPEN).length;
  }

  purge() {
    this.ctx.storage.sql.exec('DELETE FROM messages');
    this.broadcast({ t: 'system', text: 'history cleared by the operator' });
  }

  private history(): Message[] {
    return this.ctx.storage.sql
      .exec<Message>('SELECT id, name, text, ts FROM messages ORDER BY id DESC LIMIT ?', HISTORY_SEND)
      .toArray()
      .reverse();
  }

  private broadcast(payload: unknown, except?: WebSocket) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* socket already closing */
      }
    }
  }

  private send(ws: WebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let msg: { t?: string; text?: unknown; name?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment;

    switch (msg.t) {
      case 'hello': {
        const wanted = cleanName(msg.name);
        if (wanted) me.name = wanted;
        ws.serializeAttachment(me);
        this.send(ws, { t: 'welcome', you: { name: me.name }, history: this.history(), online: this.online() });
        this.broadcast({ t: 'presence', online: this.online() }, ws);
        return;
      }
      case 'name': {
        const wanted = cleanName(msg.name);
        if (!wanted) return this.send(ws, { t: 'error', text: 'Handles are 2–24 letters, digits, spaces, . _ -' });
        const old = me.name;
        me.name = wanted;
        ws.serializeAttachment(me);
        this.send(ws, { t: 'welcome', you: { name: me.name }, history: [], online: this.online() });
        if (old !== wanted) this.broadcast({ t: 'system', text: `${old} is now ${wanted}` });
        return;
      }
      case 'msg': {
        const text = cleanText(msg.text);
        if (!text) return;
        // token bucket per connection
        const now = Date.now();
        me.tokens = Math.min(BUCKET, me.tokens + (now - me.refill) / REFILL_MS);
        me.refill = now;
        if (me.tokens < 1) {
          ws.serializeAttachment(me);
          return this.send(ws, { t: 'error', text: 'Slow down: the colony can only hear so fast.' });
        }
        me.tokens -= 1;
        ws.serializeAttachment(me);
        const row = this.ctx.storage.sql
          .exec<{ id: number }>('INSERT INTO messages (name, text, ts) VALUES (?, ?, ?) RETURNING id', me.name, text, now)
          .one();
        this.ctx.storage.sql.exec('DELETE FROM messages WHERE id <= ?', row.id - HISTORY_KEEP);
        this.broadcast({ t: 'msg', id: row.id, name: me.name, text, ts: now });
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
    this.broadcast({ t: 'presence', online: this.online(ws) }, ws);
  }

  async webSocketError(ws: WebSocket) {
    this.broadcast({ t: 'presence', online: this.online(ws) }, ws);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const cors: Record<string, string> = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const room = env.ROOM.getByName('colony');

    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      if (!allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
      return room.fetch(req);
    }
    if (url.pathname === '/presence' && req.method === 'GET') {
      return Response.json({ online: await room.online() }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/history' && req.method === 'DELETE') {
      if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return new Response('Forbidden', { status: 403 });
      await room.purge();
      return new Response(null, { status: 204 });
    }
    return new Response('gpojani colony channel', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
