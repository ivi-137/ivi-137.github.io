/**
 * Organismo 23: the audio thread. One processor renders the whole instrument, sample by sample. The engine is
 * dsp.ts; this file only moves messages, and reports back what the panel's lamps, pins and tapes need.
 */
import { Organismo } from './dsp';
import { BANKS, defaults, rle, type Dump, type Mon, type Tape, type ToDsp } from './params';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const MON_EVERY = Math.round(sampleRate / 30);

class OrganismoProcessor extends AudioWorkletProcessor {
  core = new Organismo(sampleRate, defaults());
  since = 0;
  seen: number[][] = Array.from({ length: BANKS }, () => [-1, -1, -1, -1]);
  lastBank = -1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToDsp>) => {
      const m = e.data;
      const c = this.core;
      switch (m.t) {
        case 'init':
          c.p.set(m.p);
          c.setCables(m.cables);
          c.sync();
          break;
        case 'p':
          c.set(m.i, m.v);
          break;
        case 'cables':
          c.setCables(m.c);
          break;
        case 'lr':
          c.button(m.ch, m.btn, m.down);
          break;
        case 'rc':
          c.rcButton(m.btn, m.down);
          break;
        case 'rst':
          c.rst();
          break;
        case 'bank':
          c.lr.bank = Math.max(0, Math.min(BANKS - 1, m.b | 0));
          break;
        case 'sens':
          c.setSensor(m.i, m.v);
          break;
        case 'trig':
          c.trigger(m.ch, m.v);
          break;
        case 'note':
          c.note(m.note, m.vel, m.on);
          break;
        case 'cc':
          c.cc(m.cc, m.v);
          break;
        case 'bend':
          c.bend(m.v);
          break;
        case 'cv':
          c.setCv(m.i, m.v);
          break;
        case 'mclk':
          c.midiClock();
          break;
        case 'mstart':
          c.midiStart();
          break;
        case 'mstop':
          c.midiStop();
          break;
        case 'mic':
          c.micEnable(m.on);
          break;
        case 'loops':
          c.setLoops(m.data);
          break;
        case 'dump': {
          const d: Dump = { t: 'dump', data: c.loops() };
          this.port.postMessage(d);
          break;
        }
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    this.core.process(L, R, L.length, this.core.micOn ? inputs[0]?.[0] : null);
    this.since += L.length;
    if (this.since >= MON_EVERY) {
      this.since = 0;
      const mon: Mon = this.core.mon();
      this.port.postMessage(mon);
      // a tape is sent when it changes, so the panel can draw what has been recorded
      const bank = this.core.lr.bank;
      // moving to another bank shows that bank's four tapes
      if (bank !== this.lastBank) {
        this.seen[bank].fill(-1);
        this.lastBank = bank;
      }
      for (let ch = 0; ch < 4; ch++) {
        const rev = this.core.lr.rev[bank][ch];
        if (rev !== this.seen[bank][ch]) {
          this.seen[bank][ch] = rev;
          const tape: Tape = { t: 'tape', bank, ch, r: rle(this.core.lr.mem[bank][ch]) };
          this.port.postMessage(tape);
        }
      }
    }
    return true;
  }
}

registerProcessor('organismo', OrganismoProcessor);
