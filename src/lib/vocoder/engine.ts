/**
 * Melencolia's main-thread engine: the AudioContext, the vocoder worklet, the
 * microphone, a monitor you can switch off, two recording taps (the dry voice
 * and the vocoder), playing a take back through the vocoder, and rendering a
 * take offline, faster than real time.
 */
import vocUrl from './vocoder.worklet.ts?worker&url';
import { loadTap, Tap } from '../audio/recorder';
import { VIDX, VPARAMS, type FromVoc } from './params';

export class VocEngine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  monitor!: GainNode;
  dryTap!: Tap;
  wetTap!: Tap;
  private mic: { stream: MediaStream; src: MediaStreamAudioSourceNode; echoCancel: boolean } | null = null;
  private play: AudioBufferSourceNode | null = null;
  private booting: Promise<void> | null = null;
  onMsg: (m: FromVoc) => void = () => {};

  boot(p: Record<string, number>): Promise<void> {
    this.booting ??= (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await Promise.all([ctx.audioWorklet.addModule(vocUrl), loadTap(ctx)]);
      this.node = new AudioWorkletNode(ctx, 'melencolia', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { p: VPARAMS.map((s) => p[s.id] ?? s.def) },
      });
      this.node.port.onmessage = (e: MessageEvent<FromVoc>) => this.onMsg(e.data);
      this.monitor = ctx.createGain();
      this.node.connect(this.monitor).connect(ctx.destination);
      this.dryTap = new Tap(ctx, 1);
      this.wetTap = new Tap(ctx, 2);
      this.node.connect(this.wetTap.node);
    })();
    return this.booting;
  }
  get ready() {
    return !!this.node;
  }
  param(id: string, v: number) {
    const i = VIDX[id];
    if (i !== undefined) this.node?.port.postMessage({ t: 'p', i, v });
  }
  all(p: Record<string, number>) {
    this.node?.port.postMessage({ t: 'all', p: VPARAMS.map((s) => p[s.id] ?? s.def) });
  }
  cmd(c: 'next' | 'restart' | 'calibrate') {
    this.node?.port.postMessage({ t: 'cmd', c });
  }
  setMonitor(on: boolean) {
    if (!this.ctx) return;
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.03);
  }

  /**
   * Open the microphone. With speakers, ask the browser for its echo
   * canceller too; with headphones, keep the voice untouched. Automatic gain
   * and noise suppression stay off: they would fight the vocoder's envelopes.
   */
  async micOn(speakers: boolean) {
    if (!this.ctx || !this.node) return;
    if (this.mic && this.mic.echoCancel === speakers) return;
    this.micOff();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: speakers, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    src.connect(this.dryTap.node);
    this.mic = { stream, src, echoCancel: speakers };
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

  /** Play a take into the vocoder instead of the microphone (the mic is muted meanwhile). */
  playThrough(channels: Float32Array[], sampleRate: number, onEnd: () => void) {
    if (!this.ctx || !this.node) return;
    this.stopPlay();
    const buf = this.ctx.createBuffer(1, channels[0].length, sampleRate);
    buf.copyToChannel(mono(channels), 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    this.mic?.src.disconnect(this.node);
    src.connect(this.node);
    src.onended = () => {
      if (this.play === src) this.play = null;
      if (this.mic && this.node) this.mic.src.connect(this.node);
      onEnd();
    };
    src.start();
    this.play = src;
  }
  stopPlay() {
    this.play?.stop();
    this.play = null;
  }

  async resume() {
    await this.ctx?.resume();
  }

  dispose() {
    this.stopPlay();
    this.micOff();
    this.node?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.booting = null;
  }
}

export function mono(channels: Float32Array[]): Float32Array<ArrayBuffer> {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * Put a recorded voice through the vocoder offline: same worklet, same
 * settings, rendered as fast as the machine allows, with a few seconds of tail.
 */
export async function renderOffline(channels: Float32Array[], sampleRate: number, p: Record<string, number>, tail = 3): Promise<Float32Array[]> {
  const frames = channels[0].length + Math.round(tail * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  await ctx.audioWorklet.addModule(vocUrl);
  const params = { ...p };
  params['car.solo'] = 0; // a take is a voice: never render with the bands forced open
  const node = new AudioWorkletNode(ctx, 'melencolia', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { p: VPARAMS.map((s) => params[s.id] ?? s.def), offline: true, seed: 137 },
  });
  const buf = ctx.createBuffer(1, channels[0].length, sampleRate);
  buf.copyToChannel(mono(channels), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(node).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
}
