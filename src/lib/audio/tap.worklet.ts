/**
 * A recording tap: whatever is connected to its input is copied, sample for
 * sample, to the main thread while recording. It outputs silence, so it can
 * be connected to the destination just to keep it running.
 */
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
interface Options {
  processorOptions?: { channels?: number };
}

const CHUNK = 8192;

class Tap extends AudioWorkletProcessor {
  channels: number;
  rec = false;
  bufs: Float32Array[] = [];
  n = 0;
  constructor(opts: Options) {
    super();
    this.channels = opts.processorOptions?.channels ?? 2;
    this.port.onmessage = (e: MessageEvent<string>) => {
      if (e.data === 'start') {
        this.rec = true;
        this.fresh();
      } else if (e.data === 'stop') {
        this.flush(true);
        this.rec = false;
      }
    };
  }
  fresh() {
    this.bufs = Array.from({ length: this.channels }, () => new Float32Array(CHUNK));
    this.n = 0;
  }
  flush(end: boolean) {
    const data = this.bufs.map((b) => (this.n === CHUNK ? b : b.slice(0, this.n)));
    this.port.postMessage({ data, end }, data.map((d) => d.buffer));
    this.fresh();
  }
  process(inputs: Float32Array[][]) {
    if (!this.rec) return true;
    const inp = inputs[0];
    const len = inp?.[0]?.length ?? 128;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.channels; c++) {
        const src = inp?.[c] ?? inp?.[0];
        this.bufs[c][this.n] = src ? src[i] : 0;
      }
      if (++this.n === CHUNK) this.flush(false);
    }
    return true;
  }
}

registerProcessor('tap', Tap);
