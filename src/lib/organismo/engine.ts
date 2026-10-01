/**
 * The main-thread side of Organismo 23: one AudioContext, one AudioWorkletNode running organismo.worklet.ts, an
 * analyser for the scope, an optional microphone for the first adapter pin, and a lossless recorder tap.
 */
import workletUrl from './organismo.worklet.ts?worker&url';
import { loadTap, Tap } from '../audio/recorder';
import type { Btn, Cable, Dump, Mon, Tape, ToDsp } from './params';

export class Engine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser!: AnalyserNode;
  private tap: Tap | null = null;
  private booting: Promise<void> | null = null;
  private mic: { stream: MediaStream; src: MediaStreamAudioSourceNode } | null = null;
  private dumps: Array<(d: number[][][]) => void> = [];
  onMon: (m: Mon) => void = () => {};
  onTape: (t: Tape) => void = () => {};

  /** Build the audio graph (this must follow a user gesture) and hand the worklet the whole patch. */
  boot(p: ArrayLike<number>, cables: Cable[], loops: number[][][]): Promise<void> {
    this.booting ??= (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'organismo', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node = node;
      node.port.onmessage = (e: MessageEvent<Mon | Dump | Tape>) => {
        const m = e.data;
        if (m.t === 'mon') this.onMon(m);
        else if (m.t === 'tape') this.onTape(m);
        else if (m.t === 'dump') this.dumps.shift()?.(m.data);
      };
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      node.connect(this.analyser).connect(ctx.destination);
      this.post({ t: 'init', p: Array.from(p), cables });
      this.post({ t: 'loops', data: loops });
    })();
    return this.booting;
  }

  get ready() {
    return !!this.node;
  }
  get running() {
    return this.ctx?.state === 'running';
  }

  post(m: ToDsp) {
    this.node?.port.postMessage(m);
  }
  param(i: number, v: number) {
    this.post({ t: 'p', i, v });
  }
  cables(c: Cable[]) {
    this.post({ t: 'cables', c });
  }
  button(ch: number, btn: Btn, down: boolean) {
    this.post({ t: 'lr', ch, btn, down });
  }
  rc(btn: 'L' | 'M' | 'BANK', down: boolean) {
    this.post({ t: 'rc', btn, down });
  }
  bank(b: number) {
    this.post({ t: 'bank', b });
  }
  /** Ask the audio thread for every loop, as run-length codes. */
  dump(): Promise<number[][][]> {
    return new Promise((resolve) => {
      if (!this.node) return resolve([]);
      this.dumps.push(resolve);
      this.post({ t: 'dump' });
      setTimeout(() => {
        const i = this.dumps.indexOf(resolve);
        if (i >= 0) {
          this.dumps.splice(i, 1);
          resolve([]);
        }
      }, 1500);
    });
  }
  async resume() {
    await this.ctx?.resume();
  }
  async suspend() {
    await this.ctx?.suspend();
  }

  /** The first adapter pin can take a microphone or a line input. */
  async micOn() {
    if (!this.ctx || !this.node || this.mic) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    this.mic = { stream, src };
    this.post({ t: 'mic', on: true });
  }
  micOff() {
    if (!this.mic) return;
    this.mic.src.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.post({ t: 'mic', on: false });
  }
  get micActive() {
    return !!this.mic;
  }

  /** A recording tap on the master bus, created on first use. */
  async recorder(): Promise<Tap> {
    if (!this.tap) {
      await loadTap(this.ctx!);
      this.tap = new Tap(this.ctx!, 2);
      this.analyser.connect(this.tap.node);
    }
    return this.tap;
  }

  dispose() {
    this.micOff();
    this.tap?.dispose();
    this.node?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.tap = null;
    this.booting = null;
  }
}
