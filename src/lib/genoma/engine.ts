/**
 * Genoma's main-thread engine: the AudioContext, the one worklet that is the
 * whole instrument, the microphone, and a tap that records the master output.
 */
import workletUrl from './genoma.worklet.ts?worker&url';
import { loadTap, Tap } from '../audio/recorder';
import type { FromG, ToG } from './msg';

export class GenomaEngine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  tap!: Tap;
  private mic: { stream: MediaStream; src: MediaStreamAudioSourceNode; echo: boolean } | null = null;
  private booting: Promise<void> | null = null;
  private dumps = new Map<number, (d: { L: Float32Array; R: Float32Array; marks: number[]; sr: number }) => void>();
  private dumpId = 0;
  onMsg: (m: FromG) => void = () => {};
  onError: (why: string) => void = () => {};

  boot(p: number[], first: ToG[]): Promise<void> {
    this.booting ??= (async () => {
      // phones get a little more buffer: fewer dropouts, a few milliseconds more latency
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      const ctx = new AudioContext({ latencyHint: coarse ? 'balanced' : 'interactive' });
      this.ctx = ctx;
      await Promise.all([ctx.audioWorklet.addModule(workletUrl), loadTap(ctx)]);
      const node = new AudioWorkletNode(ctx, 'genoma', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { p },
      });
      node.onprocessorerror = (e) => {
        console.error('Genoma: the audio thread stopped', e);
        this.onError('the audio thread stopped with an error; reload the page');
      };
      node.port.onmessage = (e: MessageEvent<FromG>) => {
        const m = e.data;
        if (m.t === 'dump') {
          this.dumps.get(m.id)?.(m);
          this.dumps.delete(m.id);
        } else this.onMsg(m);
      };
      for (const m of first) node.port.postMessage(m);
      node.connect(ctx.destination);
      this.tap = new Tap(ctx, 2);
      node.connect(this.tap.node);
      this.node = node;
    })();
    return this.booting;
  }
  get ready() {
    return !!this.node;
  }
  send(m: ToG, transfer: Transferable[] = []) {
    this.node?.port.postMessage(m, transfer);
  }
  /** The reel, copied out of the audio thread. */
  dump(): Promise<{ L: Float32Array; R: Float32Array; marks: number[]; sr: number }> {
    return new Promise((resolve) => {
      if (!this.node) return resolve({ L: new Float32Array(0), R: new Float32Array(0), marks: [0], sr: 48000 });
      const id = ++this.dumpId;
      this.dumps.set(id, resolve);
      this.send({ t: 'dump', id });
    });
  }

  /** The microphone: echo cancellation only with speakers; no automatic gain, no noise suppression. */
  async micOn(speakers: boolean) {
    if (!this.ctx || !this.node) return;
    if (this.mic && this.mic.echo === speakers) return;
    this.micOff();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: speakers, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    this.mic = { stream, src, echo: speakers };
  }
  micOff() {
    if (!this.mic) return;
    this.mic.src.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }
  get micOpen() {
    return !!this.mic;
  }
  async resume() {
    await this.ctx?.resume();
  }
  dispose() {
    this.micOff();
    this.node?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.booting = null;
  }
}

/** Decode any audio file to stereo at the context's rate (mono is doubled). */
export async function decodeFile(ctx: BaseAudioContext, buf: ArrayBuffer) {
  const a = await ctx.decodeAudioData(buf.slice(0));
  const L = a.getChannelData(0).slice();
  const R = a.numberOfChannels > 1 ? a.getChannelData(1).slice() : L.slice();
  return { L, R, sr: a.sampleRate };
}

/** Resample stereo audio with an OfflineAudioContext (for 48 kHz reel files). */
export async function resample(L: Float32Array, R: Float32Array, from: number, to: number) {
  if (from === to || !L.length) return { L, R };
  const frames = Math.ceil((L.length * to) / from);
  const ctx = new OfflineAudioContext(2, frames, to);
  const b = ctx.createBuffer(2, L.length, from);
  b.copyToChannel(L as Float32Array<ArrayBuffer>, 0);
  b.copyToChannel(R as Float32Array<ArrayBuffer>, 1);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start();
  const out = await ctx.startRendering();
  return { L: out.getChannelData(0).slice(), R: out.getChannelData(1).slice() };
}
