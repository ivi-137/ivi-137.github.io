/**
 * WAV files: PCM in a RIFF container, readable by every player and editor.
 * 16-bit (with triangular dither) or 24-bit, with a LIST/INFO chunk that
 * carries the title, the artist and the software that made it.
 */

export interface WavInfo {
  title?: string;
  artist?: string;
  software?: string;
  date?: string;
}

/** Join recorded chunks of one channel into a single array. */
export function concat(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function peak(channels: Float32Array[]) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}

function infoChunk(info: WavInfo): Uint8Array {
  const fields: Array<[string, string | undefined]> = [
    ['INAM', info.title],
    ['IART', info.artist],
    ['ISFT', info.software],
    ['ICRD', info.date],
  ];
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [id, text] of fields) {
    if (!text) continue;
    const body = enc.encode(text.replace(/[^\x20-\x7e]/g, '?') + '\0');
    const padded = body.length + (body.length & 1);
    const p = new Uint8Array(8 + padded);
    const dv = new DataView(p.buffer);
    for (let i = 0; i < 4; i++) p[i] = id.charCodeAt(i);
    dv.setUint32(4, body.length, true);
    p.set(body, 8);
    parts.push(p);
  }
  if (!parts.length) return new Uint8Array(0);
  const size = 4 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(8 + size);
  const dv = new DataView(out.buffer);
  out.set([76, 73, 83, 84], 0); // LIST
  dv.setUint32(4, size, true);
  out.set([73, 78, 70, 79], 8); // INFO
  let o = 12;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Encode channels (all the same length) as a WAV file.
 * `normalize` scales the loudest sample to −1 dBFS first.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 = 16, info: WavInfo = {}, normalize = false): Blob {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = bits / 8;
  const gain = normalize ? 0.891 / Math.max(1e-6, peak(channels)) : 1;
  const list = infoChunk(info);
  const dataSize = frames * nch * bytes;
  const buf = new ArrayBuffer(44 + list.length + dataSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + list.length + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * bytes, true);
  dv.setUint16(32, nch * bytes, true);
  dv.setUint16(34, bits, true);
  u8.set(list, 36);
  let o = 36 + list.length;
  str(o, 'data');
  dv.setUint32(o + 4, dataSize, true);
  o += 8;
  const max = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      let x = channels[c][i] * gain;
      // triangular dither at 16 bits: quantisation noise instead of distortion
      if (bits === 16) x += (Math.random() - Math.random()) / 32768;
      const v = Math.round(Math.max(-1, Math.min(1, x)) * max);
      if (bits === 16) dv.setInt16(o, v, true);
      else {
        dv.setUint8(o, v & 0xff);
        dv.setUint8(o + 1, (v >> 8) & 0xff);
        dv.setUint8(o + 2, (v >> 16) & 0xff);
      }
      o += bytes;
    }
  return new Blob([buf], { type: 'audio/wav' });
}

/** A coarse waveform (max |x| per bucket) for drawing a take. */
export function overview(channels: Float32Array[], buckets = 240): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(buckets);
  if (!n) return out;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b / buckets) * n),
      z = Math.max(a + 1, Math.floor(((b + 1) / buckets) * n));
    let m = 0;
    for (const ch of channels) for (let i = a; i < z; i++) m = Math.max(m, Math.abs(ch[i]));
    out[b] = m;
  }
  return out;
}

export const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
