/**
 * The main-thread side of the audio engine: one AudioContext, one
 * AudioWorkletNode running dsp.worklet.ts, analysers for the scopes, a
 * recorder tap and an optional microphone ("campo") input.
 */
import dspUrl from './dsp.worklet.ts?worker&url';
import { PARAMS, PEDALS, PIDX, type Cable, type FromDsp, type SynthEvent, type ToDsp } from './params';
import type { OrfeoState } from './state';

export class Engine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser!: AnalyserNode;
  anL!: AnalyserNode;
  anR!: AnalyserNode;
  private recDest!: MediaStreamAudioDestinationNode;
  private mic: { stream: MediaStream; src: MediaStreamAudioSourceNode } | null = null;
  private booting: Promise<void> | null = null;
  onMon: (m: FromDsp) => void = () => {};

  /** Create the audio graph (must follow a user gesture) and hand the worklet the whole state. */
  boot(state: OrfeoState): Promise<void> {
    this.booting ??= (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(dspUrl);
      const node = new AudioWorkletNode(ctx, 'orfeo', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node = node;
      node.port.onmessage = (e: MessageEvent<FromDsp>) => this.onMon(e.data);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      const split = ctx.createChannelSplitter(2);
      this.anL = ctx.createAnalyser();
      this.anR = ctx.createAnalyser();
      this.anL.fftSize = this.anR.fftSize = 1024;
      this.recDest = ctx.createMediaStreamDestination();
      node.connect(this.analyser).connect(ctx.destination);
      node.connect(split);
      split.connect(this.anL, 0);
      split.connect(this.anR, 1);
      node.connect(this.recDest);
      this.sync(state);
    })();
    return this.booting;
  }

  get ready() {
    return !!this.node;
  }
  get now() {
    return this.ctx?.currentTime ?? 0;
  }

  private post(m: ToDsp) {
    this.node?.port.postMessage(m);
  }
  /** Send everything: after boot, a preset, a share link, a boon. */
  sync(s: OrfeoState) {
    this.post({ t: 'init', p: PARAMS.map((sp) => s.p[sp.id] ?? sp.def), order: this.orderIdx(s.order), cables: s.cables });
  }
  param(id: string, v: number) {
    const i = PIDX[id];
    if (i !== undefined) this.post({ t: 'p', i, v });
  }
  events(e: SynthEvent[]) {
    if (e.length) this.post({ t: 'ev', e });
  }
  cables(c: Cable[]) {
    this.post({ t: 'cables', c });
  }
  order(ids: string[]) {
    this.post({ t: 'order', o: this.orderIdx(ids) });
  }
  private orderIdx(ids: string[]) {
    return ids.map((id) => PEDALS.findIndex((p) => p.id === id)).filter((i) => i >= 0);
  }
  ctl(k: 'press' | 'x' | 'y' | 'colony', v: number) {
    this.post({ t: 'ctl', k, v });
  }
  cmd(c: 'capture' | 'release' | 'panic') {
    this.post({ t: 'cmd', c });
  }
  async resume() {
    await this.ctx?.resume();
  }

  /** Map an AudioContext time to performance.now() time, for timestamped MIDI output. */
  toPerf(t: number) {
    const ctx = this.ctx;
    if (!ctx) return performance.now();
    const ts = ctx.getOutputTimestamp?.();
    if (ts?.contextTime !== undefined && ts.performanceTime !== undefined) return ts.performanceTime + (t - ts.contextTime) * 1000;
    return performance.now() + (t - ctx.currentTime) * 1000;
  }

  /** Route a microphone or line input into the voice ("campo"). */
  async micOn() {
    if (!this.ctx || !this.node || this.mic) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    this.mic = { stream, src };
  }
  micOff() {
    if (!this.mic) return;
    this.mic.src.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }
  get micActive() {
    return !!this.mic;
  }

  /** Record the master output; call the returned function to stop and get the file. */
  record(): () => Promise<{ blob: Blob; ext: string }> {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const rec = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    return () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          const type = rec.mimeType || mimeType || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), ext: type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm' });
        };
        rec.stop();
      });
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
