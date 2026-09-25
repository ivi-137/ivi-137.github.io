/**
 * Recording any Web Audio node to lossless takes, and a small takes list
 * (listen, download as WAV, delete) shared by the site's instruments.
 */
import tapUrl from './tap.worklet.ts?worker&url';
import { concat, encodeWav, overview, stamp, type WavInfo } from './wav';

const loaded = new WeakSet<BaseAudioContext>();
export async function loadTap(ctx: BaseAudioContext) {
  if (loaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(tapUrl);
  loaded.add(ctx);
}

export interface Take {
  id: number;
  name: string;
  kind: string;
  sampleRate: number;
  channels: Float32Array[];
  seconds: number;
  date: Date;
}

/** Records whatever is connected to `input`. */
export class Tap {
  node: AudioWorkletNode;
  ctx: BaseAudioContext;
  channels: number;
  private chunks: Float32Array[][] = [];
  private done: (() => void) | null = null;
  frames = 0;
  recording = false;
  /** max |x| of the last chunk, for a level meter */
  level = 0;

  constructor(ctx: BaseAudioContext, channels = 2) {
    this.ctx = ctx;
    this.channels = channels;
    this.node = new AudioWorkletNode(ctx, 'tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { channels },
    });
    // silent output, pulled by the destination so the tap keeps running
    this.node.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<{ data: Float32Array[]; end: boolean }>) => {
      const { data, end } = e.data;
      data.forEach((d, c) => (this.chunks[c] ??= []).push(d));
      this.frames += data[0]?.length ?? 0;
      let m = 0;
      for (const d of data) for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.abs(d[i]));
      this.level = m;
      if (end) this.done?.();
    };
  }

  get seconds() {
    return this.frames / this.ctx.sampleRate;
  }

  start() {
    this.chunks = Array.from({ length: this.channels }, () => []);
    this.frames = 0;
    this.recording = true;
    this.node.port.postMessage('start');
  }

  /** Stop and return the recording, one Float32Array per channel. */
  stop(): Promise<Float32Array[]> {
    if (!this.recording) return Promise.resolve([]);
    this.recording = false;
    return new Promise((resolve) => {
      const finish = () => {
        this.done = null;
        resolve(this.chunks.map(concat));
      };
      this.done = finish;
      this.node.port.postMessage('stop');
      setTimeout(() => this.done && finish(), 1500); // the audio thread went away
    });
  }

  dispose() {
    this.node.disconnect();
  }
}

let takeId = 0;
export function makeTake(channels: Float32Array[], sampleRate: number, name: string, kind: string): Take {
  return { id: ++takeId, name, kind, sampleRate, channels, seconds: (channels[0]?.length ?? 0) / sampleRate, date: new Date() };
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export interface TakeAction {
  label: string;
  title?: string;
  when?: (t: Take) => boolean;
  run: (t: Take, el: HTMLElement) => void;
}

/**
 * A list of takes: a waveform, a player, "scarica WAV" and ✕ for each, plus
 * any extra actions the instrument wants (e.g. "apply the vocoder").
 */
export function takesList(host: HTMLElement, opts: { file: string; info: WavInfo; actions?: TakeAction[]; ink?: string; empty?: string }) {
  const takes: Take[] = [];
  const urls = new Map<number, string>();
  const empty = () => {
    if (!takes.length) host.innerHTML = `<li class="takes__empty mono">${opts.empty ?? 'no takes yet'}</li>`;
  };
  empty();

  function draw(canvas: HTMLCanvasElement, t: Take) {
    const w = (canvas.width = canvas.clientWidth * 2 || 480),
      h = (canvas.height = canvas.clientHeight * 2 || 60);
    const g = canvas.getContext('2d')!;
    const ov = overview(t.channels, Math.max(60, Math.floor(w / 3)));
    g.clearRect(0, 0, w, h);
    g.fillStyle = opts.ink ?? '#16140f';
    const bw = w / ov.length;
    for (let i = 0; i < ov.length; i++) {
      const a = Math.max(1, ov[i] * h * 0.92);
      g.fillRect(i * bw, (h - a) / 2, Math.max(1, bw - 1), a);
    }
  }

  function add(t: Take) {
    if (!takes.length) host.innerHTML = '';
    takes.unshift(t);
    const url = URL.createObjectURL(encodeWav(t.channels, t.sampleRate, 16, opts.info));
    urls.set(t.id, url);
    const li = document.createElement('li');
    li.className = 'take';
    li.dataset.take = String(t.id);
    li.innerHTML = `
      <div class="take__head"><b>${t.name}</b><span class="mono">${t.kind} · ${fmtTime(t.seconds)} · ${t.channels.length === 1 ? 'mono' : 'stereo'} · ${t.sampleRate / 1000} kHz</span></div>
      <canvas class="take__wave" aria-hidden="true"></canvas>
      <audio controls preload="metadata" src="${url}"></audio>
      <div class="take__acts mono">
        <button type="button" class="chip" data-act="wav16" title="16-bit WAV, dithered">scarica WAV</button>
        <button type="button" class="chip" data-act="wav24" title="24-bit WAV, for editing">WAV 24-bit</button>
        ${(opts.actions ?? [])
          .map((a, i) => ((a.when ?? (() => true))(t) ? `<button type="button" class="chip" data-act="x${i}" title="${a.title ?? ''}">${a.label}</button>` : ''))
          .join('')}
        <button type="button" class="chip" data-act="del" aria-label="Delete take">✕</button>
      </div>`;
    host.prepend(li);
    requestAnimationFrame(() => draw(li.querySelector('canvas')!, t));
    li.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      const base = `${opts.file}-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp(t.date)}`;
      if (act === 'wav16') download(encodeWav(t.channels, t.sampleRate, 16, opts.info), `${base}.wav`);
      else if (act === 'wav24') download(encodeWav(t.channels, t.sampleRate, 24, opts.info), `${base}-24bit.wav`);
      else if (act === 'del') {
        URL.revokeObjectURL(urls.get(t.id)!);
        urls.delete(t.id);
        takes.splice(takes.indexOf(t), 1);
        li.remove();
        empty();
      } else opts.actions?.[Number(act.slice(1))]?.run(t, li);
    });
    return li;
  }

  return {
    add,
    get takes() {
      return takes;
    },
    dispose() {
      urls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
