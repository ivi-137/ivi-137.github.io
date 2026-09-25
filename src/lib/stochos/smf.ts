/** Standard MIDI File, format 1 (MIDI Manufacturers Association, SMF 1.0): a tempo track plus one track per voice. */
export type SmfEvent = { tick: number; data: number[] };

const vlq = (n: number) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const chunk = (tag: string, body: number[]) => [...tag].map((c) => c.charCodeAt(0)).concat([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255], body);

export function smf(tracks: SmfEvent[][], ppq: number, bpm: number, names: string[] = []): Uint8Array {
  const us = Math.round(60_000_000 / bpm);
  const tempo = [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xff, 0x2f, 0];
  const chunks = [chunk('MTrk', tempo)];
  tracks.forEach((evs, ti) => {
    const body: number[] = [];
    const name = [...(names[ti] ?? `track ${ti + 1}`)].map((c) => c.charCodeAt(0) & 127);
    body.push(0, 0xff, 0x03, name.length, ...name);
    let last = 0;
    for (const e of [...evs].sort((a, b) => a.tick - b.tick || (a.data[0] & 0xf0) - (b.data[0] & 0xf0))) {
      body.push(...vlq(Math.max(0, e.tick - last)), ...e.data);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk('MTrk', body));
  });
  const n = chunks.length;
  return Uint8Array.from([...chunk('MThd', [0, 1, (n >> 8) & 255, n & 255, (ppq >> 8) & 255, ppq & 255]), ...chunks.flat()]);
}
