/**
 * Web MIDI: notes in (to the lead voice and the Continuator), CC in (MIDI
 * learn), clock in (follow an external tempo), and notes + clock out.
 */
export interface MidiHandlers {
  note(on: boolean, note: number, vel: number, ch: number): void;
  cc(cc: number, value: number, ch: number): void;
  clock(): void;
  start(): void;
  stop(): void;
}

export class Midi {
  access: MIDIAccess | null = null;
  out: MIDIOutput | null = null;
  inId = 'all';
  private h: MidiHandlers;
  constructor(h: MidiHandlers) {
    this.h = h;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async enable() {
    if (this.access) return this.access;
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.bind();
    this.bind();
    return this.access;
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }
  get outputs() {
    return this.access ? [...this.access.outputs.values()] : [];
  }

  private bind() {
    for (const input of this.inputs) input.onmidimessage = this.inId === 'all' || input.id === this.inId ? (e) => this.onMessage(e) : null;
  }
  selectInput(id: string) {
    this.inId = id;
    this.bind();
  }
  selectOutput(id: string) {
    this.out = this.outputs.find((o) => o.id === id) ?? null;
  }

  private onMessage(e: MIDIMessageEvent) {
    const d = e.data;
    if (!d?.length) return;
    const status = d[0];
    if (status === 0xf8) return this.h.clock();
    if (status === 0xfa || status === 0xfb) return this.h.start();
    if (status === 0xfc) return this.h.stop();
    const type = status & 0xf0,
      ch = status & 0x0f;
    if (type === 0x90 && d[2] > 0) this.h.note(true, d[1], d[2] / 127, ch);
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) this.h.note(false, d[1], 0, ch);
    else if (type === 0xb0) this.h.cc(d[1], d[2] / 127, ch);
  }

  /** Send a note with sample-accurate-ish timing: `at` and `off` are performance.now() times. */
  note(ch: number, note: number, vel: number, at: number, off: number) {
    if (!this.out) return;
    const n = Math.max(0, Math.min(127, Math.round(note)));
    this.out.send([0x90 | ch, n, Math.max(1, Math.min(127, Math.round(vel * 127)))], at);
    this.out.send([0x80 | ch, n, 0], off);
  }
  clock(at: number) {
    this.out?.send([0xf8], at);
  }
  transport(start: boolean) {
    this.out?.send([start ? 0xfa : 0xfc]);
  }
  panic() {
    if (!this.out) return;
    for (let ch = 0; ch < 16; ch++) this.out.send([0xb0 | ch, 123, 0]);
  }
}
