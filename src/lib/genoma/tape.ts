/**
 * The reel: stereo audio in 32k-sample chunks (allocated as recording
 * reaches them, so an empty reel costs nothing), and the splice markers that
 * cut it into pieces. Also the reel's file format: a 32-bit float WAV whose
 * splice markers travel as cue points, the way the Morphagene keeps its reels
 * on the SD card.
 */
export const CHUNK_BITS = 15;
export const CHUNK = 1 << CHUNK_BITS;
const MASK = CHUNK - 1;
/** The Morphagene's reel holds 2.9 minutes. */
export const REEL_SECONDS = 174;
/** Markers closer than this to another (or to an end) are refused. */
export const MIN_SPLICE_SEC = 0.01;

export class Tape {
  L: Float32Array[] = [];
  R: Float32Array[] = [];
  len = 0;
  cap: number;
  sr: number;
  /** splice starts, sorted; marks[0] is always 0 */
  marks: number[] = [0];
  /** bumped on every structural edit (markers included) */
  edits = 0;
  /** bumped only when audio moves or goes (a splice cut out, the reel cleared or replaced) */
  moves = 0;

  constructor(sr: number, seconds = REEL_SECONDS) {
    this.sr = sr;
    this.cap = Math.floor(seconds * sr);
  }

  private ensure(i: number) {
    const c = i >>> CHUNK_BITS;
    if (!this.L[c]) {
      this.L[c] = new Float32Array(CHUNK);
      this.R[c] = new Float32Array(CHUNK);
    }
  }
  /** sample i of channel ch (0 L, 1 R); 0 outside the reel */
  get(ch: number, i: number) {
    if (i < 0 || i >= this.len) return 0;
    return (ch ? this.R : this.L)[i >>> CHUNK_BITS][i & MASK];
  }
  set(i: number, l: number, r: number) {
    if (i < 0 || i >= this.cap) return;
    this.ensure(i);
    this.L[i >>> CHUNK_BITS][i & MASK] = l;
    this.R[i >>> CHUNK_BITS][i & MASK] = r;
  }
  /** Append one frame at the end; false when the reel is full. */
  append(l: number, r: number) {
    if (this.len >= this.cap) return false;
    this.set(this.len, l, r);
    this.len++;
    return true;
  }

  get count() {
    return this.len > 0 ? this.marks.length : 0;
  }
  /** [start, end) of splice k */
  bounds(k: number): [number, number] {
    const n = this.marks.length;
    k = Math.max(0, Math.min(n - 1, k));
    return [this.marks[k], k + 1 < n ? this.marks[k + 1] : this.len];
  }
  /** index of the splice that holds position pos */
  spliceAt(pos: number) {
    let lo = 0,
      hi = this.marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.marks[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** Add a marker; returns the new splice's index, or -1 if too close to another. */
  addMarker(pos: number) {
    pos = Math.round(pos);
    const min = MIN_SPLICE_SEC * this.sr;
    if (pos < min || pos > this.len - min) return -1;
    const k = this.spliceAt(pos);
    const [s, e] = this.bounds(k);
    if (pos - s < min || e - pos < min) return -1;
    this.marks.splice(k + 1, 0, pos);
    this.edits++;
    return k + 1;
  }
  /** Join splice k with the one after it (removes the marker at its end). */
  removeMarker(k: number) {
    if (k + 1 >= this.marks.length) return false;
    this.marks.splice(k + 1, 1);
    this.edits++;
    return true;
  }
  clearMarkers() {
    this.marks = [0];
    this.edits++;
  }
  /** Copy n frames from src to dst inside the reel (dst < src: moving left), chunk by chunk. */
  private move(dst: number, src: number, n: number) {
    while (n > 0) {
      const so = src & MASK,
        dof = dst & MASK;
      const m = Math.min(n, CHUNK - so, CHUNK - dof);
      this.ensure(dst);
      const sc = src >>> CHUNK_BITS,
        dc = dst >>> CHUNK_BITS;
      this.L[dc].set(this.L[sc].subarray(so, so + m), dof);
      this.R[dc].set(this.R[sc].subarray(so, so + m), dof);
      src += m;
      dst += m;
      n -= m;
    }
  }
  /** Remove splice k's audio from the reel; the rest closes up behind it. */
  deleteSplice(k: number) {
    if (!this.count) return false;
    const [s, e] = this.bounds(k);
    const cut = e - s;
    this.move(s, e, this.len - e);
    this.len -= cut;
    const n = this.marks.length;
    if (n === 1) this.marks = [0];
    else {
      // drop this splice's start (or, for the first splice, the next one's), shift the rest
      this.marks.splice(k === 0 ? 1 : k, 1);
      for (let i = 0; i < this.marks.length; i++) if (this.marks[i] > s) this.marks[i] -= cut;
      this.marks[0] = 0;
    }
    this.edits++;
    this.moves++;
    return true;
  }
  clear() {
    this.len = 0;
    this.marks = [0];
    this.edits++;
    this.moves++;
  }
  /** Replace the reel's contents. */
  load(L: Float32Array, R: Float32Array, marks: number[]) {
    this.clear();
    const n = Math.min(L.length, this.cap);
    for (let i = 0; i < n; i += CHUNK) {
      this.ensure(i);
      const m = Math.min(CHUNK, n - i);
      this.L[i >>> CHUNK_BITS].set(L.subarray(i, i + m));
      this.R[i >>> CHUNK_BITS].set((R.length ? R : L).subarray(i, i + m));
    }
    this.len = n;
    for (const m of [...marks].sort((a, b) => a - b)) if (m > 0) this.addMarker(m);
    this.edits++;
  }
  /** Add audio at the end of the reel as a new splice; returns its index (−1 if the reel is full). */
  appendSplice(L: Float32Array, R: Float32Array) {
    const start = this.len;
    if (start >= this.cap - MIN_SPLICE_SEC * this.sr) return -1;
    const n = Math.min(L.length, this.cap - start);
    for (let i = 0; i < n; i++) this.append(L[i], (R.length ? R : L)[i]);
    const k = start > 0 ? this.addMarker(start) : 0;
    this.edits++;
    return k >= 0 ? k : this.spliceAt(start);
  }
  /** Cut splice k into n equal splices. */
  divide(k: number, n: number) {
    const [s, e] = this.bounds(k);
    for (let i = 1; i < n; i++) this.addMarker(s + ((e - s) * i) / n);
  }
  /** The whole reel as two arrays, plus markers. */
  dump(): { L: Float32Array; R: Float32Array; marks: number[] } {
    const L = new Float32Array(this.len),
      R = new Float32Array(this.len);
    for (let i = 0; i < this.len; i += CHUNK) {
      const m = Math.min(CHUNK, this.len - i);
      L.set(this.L[i >>> CHUNK_BITS].subarray(0, m), i);
      R.set(this.R[i >>> CHUNK_BITS].subarray(0, m), i);
    }
    return { L, R, marks: [...this.marks] };
  }
  /** Peaks for drawing: n bins over [from, to), sampling every stride frames. */
  overview(n: number, from = 0, to = this.len) {
    const out = new Float32Array(n);
    to = Math.min(to, this.len);
    from = Math.max(0, from);
    if (to <= from) return out;
    const span = to - from;
    const stride = Math.max(1, Math.floor(span / n / 48));
    for (let b = 0; b < n; b++) {
      const a = from + Math.floor((b * span) / n),
        z = from + Math.floor(((b + 1) * span) / n);
      let p = 0;
      for (let i = a; i < z; i += stride) {
        const c = i >>> CHUNK_BITS,
          o = i & MASK;
        const v = Math.max(Math.abs(this.L[c][o]), Math.abs(this.R[c][o]));
        if (v > p) p = v;
      }
      out[b] = p;
    }
    return out;
  }
}

// ── the reel file: 32-bit float stereo WAV with cue points ───────────────────────

const tag = (dv: DataView, o: number, s: string) => {
  for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
};

/** A reel as a WAV file: IEEE float, stereo, every splice marker after the first as a cue point. */
export function encodeReel(L: Float32Array, R: Float32Array, sr: number, marks: number[]): ArrayBuffer {
  const frames = L.length;
  const cues = marks.filter((m) => m > 0 && m < frames);
  const dataSize = frames * 8;
  const cueSize = cues.length ? 4 + cues.length * 24 : 0;
  const size = 12 + 26 + (8 + dataSize) + (cueSize ? 8 + cueSize : 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  tag(dv, 0, 'RIFF');
  dv.setUint32(4, size - 8, true);
  tag(dv, 8, 'WAVE');
  tag(dv, 12, 'fmt ');
  dv.setUint32(16, 18, true);
  dv.setUint16(20, 3, true); // IEEE float
  dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 8, true);
  dv.setUint16(32, 8, true);
  dv.setUint16(34, 32, true);
  dv.setUint16(36, 0, true); // cbSize
  let o = 38;
  tag(dv, o, 'data');
  dv.setUint32(o + 4, dataSize, true);
  o += 8;
  for (let i = 0; i < frames; i++) {
    dv.setFloat32(o + 8 * i, L[i], true);
    dv.setFloat32(o + 8 * i + 4, R[i], true);
  }
  o += dataSize;
  if (cueSize) {
    tag(dv, o, 'cue ');
    dv.setUint32(o + 4, cueSize, true);
    dv.setUint32(o + 8, cues.length, true);
    cues.forEach((m, i) => {
      const c = o + 12 + i * 24;
      dv.setUint32(c, i + 1, true); // id
      dv.setUint32(c + 4, m, true); // position
      tag(dv, c + 8, 'data');
      dv.setUint32(c + 12, 0, true); // chunk start
      dv.setUint32(c + 16, 0, true); // block start
      dv.setUint32(c + 20, m, true); // sample offset
    });
  }
  return buf;
}

/** The sample rate in a WAV file's header, or 0 if it is not a WAV file. */
export function wavRate(buf: ArrayBuffer): number {
  if (buf.byteLength < 28) return 0;
  const dv = new DataView(buf);
  const id = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') return 0;
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const len = dv.getUint32(o + 4, true);
    if (id(o) === 'fmt ' && o + 16 <= buf.byteLength) return dv.getUint32(o + 12, true);
    o += 8 + len + (len & 1);
  }
  return 0;
}

/** Cue points (as sample frames) in a WAV file, if it has any; [] otherwise. */
export function readCues(buf: ArrayBuffer): number[] {
  const dv = new DataView(buf);
  if (buf.byteLength < 12) return [];
  const id = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') return [];
  let o = 12;
  const out: number[] = [];
  while (o + 8 <= buf.byteLength) {
    const name = id(o),
      len = dv.getUint32(o + 4, true);
    if (name === 'cue ' && o + 12 <= buf.byteLength) {
      const n = dv.getUint32(o + 8, true);
      for (let i = 0; i < n && o + 12 + i * 24 + 24 <= buf.byteLength; i++) out.push(dv.getUint32(o + 12 + i * 24 + 20, true));
    }
    o += 8 + len + (len & 1);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
