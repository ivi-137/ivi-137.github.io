/**
 * What Genoma remembers between visits: the knobs and the Operatori project in
 * localStorage (small), the reels in IndexedDB (large). Every access is
 * guarded: in a private window storage can be missing, and the page still works.
 */
import { GPARAMS } from './params';
import { PATTERNS, type Pattern, type Project } from './seq';

const P_KEY = 'genoma:p';
const PROJ_KEY = 'genoma:proj';

function get(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function set(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}

export function loadParams(): number[] {
  const p = GPARAMS.map((s) => s.def);
  try {
    const saved = JSON.parse(get(P_KEY) ?? 'null') as Record<string, number> | null;
    if (saved)
      GPARAMS.forEach((s, i) => {
        const v = saved[s.id];
        if (typeof v === 'number' && Number.isFinite(v)) p[i] = Math.min(s.max, Math.max(s.min, v));
      });
  } catch {
    /* a broken save: defaults */
  }
  return p;
}
export function saveParams(p: number[]) {
  set(P_KEY, JSON.stringify(Object.fromEntries(GPARAMS.map((s, i) => [s.id, p[i]]))));
}

/** Only patterns with something in them are written; empty ones come back as null. */
export function saveProject(proj: Project) {
  const pats: Record<number, Pattern> = {};
  proj.pats.forEach((p, i) => {
    if (p) pats[i] = p;
  });
  return set(PROJ_KEY, JSON.stringify({ ...proj, pats }));
}
export function loadProject(): Project | null {
  try {
    const raw = JSON.parse(get(PROJ_KEY) ?? 'null') as (Omit<Project, 'pats'> & { pats: Record<number, Pattern> }) | null;
    if (!raw || raw.v !== 1) return null;
    const pats: (Pattern | null)[] = new Array(PATTERNS).fill(null);
    for (const [i, p] of Object.entries(raw.pats)) pats[+i] = p;
    return { ...raw, pats };
  } catch {
    return null;
  }
}

// ── reels in IndexedDB ────────────────────────────────────────────────────────
export interface StoredReel {
  L: Float32Array;
  R: Float32Array;
  marks: number[];
  sr: number;
  date: number;
}
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('genoma', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('reels');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = run(d.transaction('reels', mode).objectStore('reels'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveReel(slot: number, r: StoredReel) {
  try {
    await tx('readwrite', (s) => s.put(r, slot));
    return true;
  } catch {
    return false;
  }
}
export async function loadReel(slot: number): Promise<StoredReel | null> {
  try {
    return ((await tx('readonly', (s) => s.get(slot))) as StoredReel | undefined) ?? null;
  } catch {
    return null;
  }
}
/** Which slots hold a reel, and how long each is. */
export async function reelIndex(): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const req = d.transaction('reels').objectStore('reels').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        const v = c.value as StoredReel;
        out[Number(c.key)] = v.L.length / v.sr;
        c.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {
    /* no IndexedDB */
  }
  return out;
}
