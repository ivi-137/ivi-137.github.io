/**
 * The main-thread side of GUZEN: one AudioContext, one AudioWorkletNode running guzen.worklet.ts, an analyser
 * for the scope and, on demand, a lossless recorder tap.
 */
import workletUrl from './guzen.worklet.ts?worker&url';
import { loadTap, Tap } from '../audio/recorder';
import type { Mon, ToDsp } from './params';

export class Engine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser!: AnalyserNode;
  private tap: Tap | null = null;
  private booting: Promise<void> | null = null;
  onMon: (m: Mon) => void = () => {};

  /** Build the audio graph (this must follow a user gesture) and hand the worklet the whole patch. */
  boot(p: ArrayLike<number>, seed: number): Promise<void> {
    this.booting ??= (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'guzen', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node = node;
      node.port.onmessage = (e: MessageEvent<Mon>) => this.onMon(e.data);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      node.connect(this.analyser).connect(ctx.destination);
      this.sync(p, seed);
    })();
    return this.booting;
  }

  get ready() {
    return !!this.node;
  }
  get running() {
    return this.ctx?.state === 'running';
  }

  private post(m: ToDsp) {
    this.node?.port.postMessage(m);
  }
  /** Send everything and start the piece again from its seed: after boot, a preset or a new seed. */
  sync(p: ArrayLike<number>, seed: number) {
    this.post({ t: 'init', p: Array.from(p), seed });
  }
  param(i: number, v: number) {
    this.post({ t: 'p', i, v });
  }
  restart(seed: number) {
    this.post({ t: 'restart', seed });
  }
  async resume() {
    await this.ctx?.resume();
  }
  async suspend() {
    await this.ctx?.suspend();
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
    this.tap?.dispose();
    this.node?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.tap = null;
    this.booting = null;
  }
}
