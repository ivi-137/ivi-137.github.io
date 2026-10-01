/**
 * GUZEN: the audio thread. One processor renders the whole instrument, sample by sample. The engine itself
 * is dsp.ts; this file only moves messages and reports back what the panel's lamps and dice need.
 */
import { Guzen } from './dsp';
import { defaults, type Mon, type ToDsp } from './params';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const MON_EVERY = Math.round(sampleRate / 30);

class GuzenProcessor extends AudioWorkletProcessor {
  core = new Guzen(sampleRate, defaults(), 1);
  since = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToDsp>) => {
      const m = e.data;
      if (m.t === 'init') {
        this.core.p.set(m.p);
        this.core.restart(m.seed);
      } else if (m.t === 'p') this.core.set(m.i, m.v);
      else if (m.t === 'restart') this.core.restart(m.seed);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    this.core.process(L, R, L.length);
    this.since += L.length;
    if (this.since >= MON_EVERY) {
      this.since = 0;
      const mon: Mon = {
        t: 'mon',
        act: this.core.agents.map((a) => a.activity),
        hi: this.core.dice.rng.hi,
        lo: this.core.dice.rng.lo,
        peak: this.core.peak,
      };
      this.port.postMessage(mon);
    }
    return true;
  }
}

registerProcessor('guzen', GuzenProcessor);
