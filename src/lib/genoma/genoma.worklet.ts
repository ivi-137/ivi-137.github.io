/**
 * Genoma: the audio thread. One processor renders the whole instrument,
 * sample by sample, so cables between modules are exact to the sample.
 *
 *   microphone ──┬──────────────────────────────────────────────┐
 *   Operatori ───┼─▶ il nastro (REC source) ─┐                   │
 *   Quinconce ◀──┴── (its input source) ◀────┴─ piezo, Quantussy  ├─▶ mixer ─▶ limiter ─▶ out
 *   posto giusto: an insert on one of those buses (or the master) ┘
 *   cavi: eight cables from gates and voltages to the modules' inputs
 */
import { Reel } from './reel';
import { Pad } from './pad';
import { Coco, Piezo, Quantussy, cocoHz } from './coco';
import { Operatori } from './fm';
import { NOTE_LENS } from './seq';
import { CABLES, CV_SRC, CV_SRC_TRACK, D, GATE_DST, GIDX, GPARAMS, CV_DST } from './params';
import type { FromG, Mon, ToG } from './msg';
import { Follower, Rng, clamp, tanh } from './fx';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SR = sampleRate;
const G = GIDX;
const MON_EVERY = Math.round(SR / 30);
const GATE_LEN = Math.round(SR * 0.008);

class Genoma extends AudioWorkletProcessor {
  p: Float64Array;
  reel = new Reel(SR);
  pad = new Pad(SR);
  cocoA = new Coco(SR);
  cocoB = new Coco(SR);
  q = new Quantussy(SR);
  piezo = new Piezo(SR);
  op = new Operatori(SR);
  rng = new Rng(3);
  segui = new Follower(SR, 3, 150);
  meterL = 0;
  meterR = 0;
  meterIn = 0;
  lvlA = 0;
  lvlB = 0;
  // previous frame's buses (for the loops between modules)
  nL = 0;
  nR = 0;
  qL = 0;
  qR = 0;
  // cables
  cv = new Float64Array(CV_SRC.length);
  gateLeft = new Int32Array(CV_SRC.length);
  mod = new Float64Array(CV_DST.length);
  high = new Uint8Array(CV_DST.length);
  clkCount = 0;
  gatesOpen = 0;
  caso = 0;
  // the pad, scrub
  padOn = false;
  padX = 0.5;
  padY = 0.5;
  // live recording
  held = new Map<string, { k: number; n: number; v: number; s: number; mt: number; rel: number }>();
  // reel display
  seenEdits = -1;
  seenCur = -1;
  ovT = 0;
  dirty = false;
  dirtyT = 0;
  monT = 0;
  lim = 1;

  constructor(opts: { processorOptions?: { p?: number[] } }) {
    super();
    this.p = Float64Array.from(opts.processorOptions?.p ?? GPARAMS.map((s) => s.def));
    this.port.onmessage = (e: MessageEvent<ToG>) => this.msg(e.data);
  }
  send(m: FromG, transfer: Transferable[] = []) {
    this.port.postMessage(m, transfer);
  }

  msg(m: ToG) {
    const op = this.op,
      seq = op.seq,
      reel = this.reel;
    switch (m.t) {
      case 'p':
        this.p[m.i] = m.v;
        break;
      case 'all':
        this.p.set(m.p);
        break;
      case 'proj':
        seq.pats = m.pats;
        seq.song = m.song;
        if (!seq.playing) seq.cur = m.cur;
        break;
      case 'pat':
        seq.pats[m.i] = m.pat;
        break;
      case 'tp': {
        const pat = seq.pats[seq.cur];
        if (pat) pat.tracks[m.k].snd[m.i] = m.v;
        break;
      }
      case 'play':
        seq.play();
        break;
      case 'stop':
        seq.stop();
        op.allOff();
        break;
      case 'queue':
        seq.queue(m.i);
        break;
      case 'song':
        seq.songMode = m.on;
        seq.song = m.rows;
        seq.songRow = Math.max(0, Math.min(m.rows.length - 1, m.row));
        break;
      case 'fill':
        seq.fill = m.on;
        break;
      case 'mutes':
        m.m.forEach((v, i) => (seq.mutes[i] = v));
        break;
      case 'key': {
        const id = `${m.k}:${m.n}`;
        op.key(m.k, m.n, m.v, m.on);
        if (m.rec && seq.playing) {
          const w = seq.where(m.k);
          if (m.on) {
            const near = Math.round(w.rel);
            this.held.set(id, {
              k: m.k,
              n: m.n,
              v: m.v,
              s: ((near % w.len) + w.len) % w.len,
              mt: Math.max(-23, Math.min(23, Math.round((w.rel - near) * 24))),
              rel: w.rel,
            });
          } else {
            const h = this.held.get(id);
            if (h) {
              const steps = Math.max(0.125, w.rel - h.rel);
              const l = NOTE_LENS.filter((x) => x > 0).reduce((a, b) => (Math.abs(b - steps) < Math.abs(a - steps) ? b : a));
              this.send({ t: 'rec', k: h.k, s: h.s, n: h.n, v: h.v, mt: h.mt, l });
            }
          }
        }
        if (!m.on) this.held.delete(id);
        break;
      }
      case 'btn':
        switch (m.b) {
          case 'rec':
            reel.recToggle();
            break;
          case 'recNew':
            reel.recNew();
            break;
          case 'splice':
            reel.splice();
            break;
          case 'shift':
            reel.shift();
            break;
          case 'delMarker':
            reel.deleteMarker();
            break;
          case 'delMarkers':
            reel.deleteAllMarkers();
            break;
          case 'delSplice':
            reel.deleteSplice();
            break;
          case 'clearReel':
            reel.clearReel();
            break;
          case 'play':
            reel.togglePlay();
            this.p[G['n.play']] = reel.playBtn ? 1 : 0;
            break;
          case 'arm': {
            const bars = [0, 1, 2, 4][this.p[G['n.qrec']] | 0];
            if (reel.armed || reel.rec) reel.recStop();
            else reel.arm(bars || 1);
            break;
          }
        }
        this.dirty = true;
        break;
      case 'select':
        reel.select(m.k);
        break;
      case 'divide':
        reel.tape.divide(reel.cur, m.n);
        this.dirty = true;
        break;
      case 'scrub':
        reel.scrub(m.on, m.x);
        break;
      case 'pad':
        this.padOn = m.on;
        this.padX = m.x;
        this.padY = m.y;
        this.p[G['r.x']] = m.x;
        this.p[G['r.y']] = m.y;
        break;
      case 'piezo':
        if (m.tap) this.piezo.tap(m.tap);
        if (m.rub !== undefined) this.piezo.rub(m.rub);
        break;
      case 'coco': {
        const c = m.w ? this.cocoB : this.cocoA;
        const w = m.w ? 'qb' : 'qa';
        if (m.c === 'flip') c.flip();
        else if (m.c === 'skip') c.skip(cocoHz(this.p[G[`${w}.speed`]]));
        else c.clear();
        break;
      }
      case 'load':
        if (m.append) {
          const k = reel.tape.appendSplice(m.L, m.R);
          if (k >= 0) reel.select(k);
          else this.send({ t: 'full' });
        } else {
          reel.clearReel();
          reel.tape.load(m.L, m.R, m.marks);
          reel.cur = 0;
        }
        this.dirty = true;
        break;
      case 'dump': {
        const d = reel.tape.dump();
        this.send({ t: 'dump', id: m.id, L: d.L, R: d.R, marks: d.marks, sr: SR }, [d.L.buffer, d.R.buffer]);
        break;
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const oL = out[0],
      oR = out[1] ?? out[0];
    const inp = inputs[0] ?? [];
    const iL = inp[0],
      iR = inp[1] ?? inp[0];
    const P = this.p;
    const op = this.op,
      seq = op.seq,
      reel = this.reel,
      pad = this.pad,
      q = this.q;
    // per block: Operatori's globals
    const g = op.g;
    g.bpm = P[G['o.bpm']];
    seq.swing = P[G['o.swing']];
    g.cho[0] = P[G['o.cho.depth']];
    g.cho[1] = P[G['o.cho.speed']];
    g.cho[2] = P[G['o.cho.width']];
    g.cho[3] = P[G['o.cho.hp']];
    g.cho[4] = P[G['o.cho.rev']];
    g.del[0] = P[G['o.del.time']];
    g.del[1] = P[G['o.del.fb']];
    g.del[2] = P[G['o.del.pp']];
    g.del[3] = P[G['o.del.width']];
    g.del[4] = P[G['o.del.hp']];
    g.del[5] = P[G['o.del.lp']];
    g.del[6] = P[G['o.del.rev']];
    g.rev[0] = P[G['o.rev.pre']];
    g.rev[1] = P[G['o.rev.decay']];
    g.rev[2] = P[G['o.rev.size']];
    g.rev[3] = P[G['o.rev.dark']];
    g.rev[4] = P[G['o.rev.hp']];
    g.rev[5] = P[G['o.rev.mix']];
    g.cmp[0] = P[G['o.cmp.thr']];
    g.cmp[1] = P[G['o.cmp.ratio']];
    g.cmp[2] = P[G['o.cmp.atk']];
    g.cmp[3] = P[G['o.cmp.rel']];
    g.cmp[4] = P[G['o.cmp.make']];
    g.cmp[5] = P[G['o.cmp.mix']];
    reel.playBtn = P[G['n.play']] > 0.5;
    const mVoce = P[G['m.voce']],
      mNastro = P[G['m.nastro']],
      mQuinc = P[G['m.quinc']],
      mOper = P[G['m.oper']],
      mVol = P[G['m.vol']];
    const nSrc = P[G['n.src']] | 0,
      nIn = P[G['n.in']];
    const nGain = nIn * nIn * 2;
    const padSrc = P[G['r.src']] | 0,
      padMode = P[G['r.mode']] | 0,
      padMix = P[G['r.mix']];
    const padHold = P[G['r.hold']] > 0.5;
    const qSrc = P[G['q.src']] | 0;
    const wood = P[G['q.wood']];
    const rates = [P[G['q.p1']], P[G['q.p2']], P[G['q.p3']], P[G['q.p4']], P[G['q.p5']]];
    q.rates(rates, P[G['q.range']] > 0.5);
    const qAudio = P[G['q.range']] > 0.5,
      chaos = P[G['q.chaos']],
      qVol = P[G['q.vol']],
      qFeed = P[G['q.feed']];
    const A = {
      hz: cocoHz(P[G['qa.speed']]),
      aff: P[G['qa.aff']],
      fb: P[G['qa.fb']],
      inp: P[G['qa.in']],
      vol: P[G['qa.vol']],
      pan: P[G['qa.pan']],
      dolby: P[G['qa.dolby']] | 0,
      rec: P[G['qa.rec']] > 0.5,
      flip: P[G['qa.flip']] | 0,
      skip: P[G['qa.skip']] | 0,
      spaf: P[G['qa.spaf']] | 0,
    };
    const B = {
      hz: cocoHz(P[G['qb.speed']]),
      aff: P[G['qb.aff']],
      fb: P[G['qb.fb']],
      inp: P[G['qb.in']],
      vol: P[G['qb.vol']],
      pan: P[G['qb.pan']],
      dolby: P[G['qb.dolby']] | 0,
      rec: P[G['qb.rec']] > 0.5,
      flip: P[G['qb.flip']] | 0,
      skip: P[G['qb.skip']] | 0,
      spaf: P[G['qb.spaf']] | 0,
      series: P[G['qb.from']] > 0.5,
    };
    const panG = (p: number): [number, number] => [Math.cos(((p + 1) * Math.PI) / 4) * 1.2, Math.sin(((p + 1) * Math.PI) / 4) * 1.2];
    const [aL, aR] = panG(A.pan),
      [bL, bR] = panG(B.pan);
    // cables, read once a block
    const cab: { src: number; dst: number; amt: number }[] = [];
    for (let c = 1; c <= CABLES; c++) {
      const src = P[G[`c${c}.src`]] | 0,
        dst = P[G[`c${c}.dst`]] | 0;
      if (src && dst) cab.push({ src, dst, amt: P[G[`c${c}.amt`]] });
    }
    const base = {
      speed: P[G['n.speed']],
      gene: P[G['n.gene']],
      slide: P[G['n.slide']],
      morph: P[G['n.morph']],
      organize: P[G['n.organize']],
      sos: P[G['n.sos']],
    };
    const ctl = { ...base };
    if (!cab.length) this.mod.fill(0);
    const beat = (60 / g.bpm) * SR;
    const cv = this.cv,
      gl = this.gateLeft,
      mod = this.mod,
      high = this.high;
    const n = oL.length;
    op.processBlock(n);
    for (let i = 0; i < n; i++) {
      let mL = iL ? iL[i] : 0,
        mR = iR ? iR[i] : mL;
      const mic = Math.max(Math.abs(mL), Math.abs(mR));
      if (mic > this.meterIn) this.meterIn = mic;
      if (padSrc === 0) {
        pad.process(mL, mR, this.padOn || padHold, padMode, this.padX, this.padY, padMix, beat);
        mL = pad.outL;
        mR = pad.outR;
      }
      // Operatori (rendered for the whole block above)
      let pL = op.bL[i],
        pR = op.bR[i];
      if (padSrc === 3) {
        pad.process(pL, pR, this.padOn || padHold, padMode, this.padX, this.padY, padMix, beat);
        pL = pad.outL;
        pR = pad.outR;
      }
      // the voltages this frame
      if (this.gatesOpen) {
        let open = 0;
        for (let s = 1; s < cv.length; s++)
          if (gl[s] > 0) {
            if (--gl[s] === 0) cv[s] = 0;
            else open++;
          }
        this.gatesOpen = open;
      }
      if (op.p16[i]) {
        cv[1] = 1;
        gl[1] = GATE_LEN;
        this.gatesOpen++;
        this.caso = this.rng.next();
      }
      if (op.pBar[i]) {
        cv[2] = 1;
        gl[2] = GATE_LEN;
        this.gatesOpen++;
        reel.bar();
      }
      cv[3] = reel.eos;
      cv[4] = reel.cv;
      for (let k = 0; k < 5; k++) cv[5 + k] = q.sq[k];
      cv[10] = clamp(this.segui.v * 3);
      cv[11] = this.caso;
      const tm = op.trigAt[i];
      if (tm)
        for (let k = 0; k < 16; k++)
          if ((tm >> k) & 1) {
            cv[CV_SRC_TRACK + k] = 1;
            gl[CV_SRC_TRACK + k] = GATE_LEN;
            this.gatesOpen++;
          }
      let gA = 0,
        gB = 0,
        playGate = false;
      if (cab.length) mod.fill(0);
      for (const c of cab) {
        const v = cv[c.src];
        if (GATE_DST.has(c.dst)) {
          const on = (c.amt >= 0 ? v : 1 - v) > 0.5 ? 1 : 0;
          if (on && !high[c.dst]) this.edge(c.dst);
          high[c.dst] = on;
          if (c.dst === D.play) playGate = playGate || !!on;
          if (c.dst === D.aRec) gA = on;
          if (c.dst === D.bRec) gB = on;
        } else mod[c.dst] += c.amt * v;
      }
      reel.playGate = playGate;
      if (cab.length) {
        ctl.speed = clamp(base.speed + mod[D.speed] * 2, -1, 1);
        ctl.gene = clamp(base.gene + mod[D.gene]);
        ctl.slide = base.slide + mod[D.slide];
        ctl.slide -= Math.floor(ctl.slide);
        ctl.morph = clamp(base.morph + mod[D.morph]);
        ctl.organize = clamp(base.organize + mod[D.organize], 0, 0.9999);
        ctl.sos = clamp(base.sos + mod[D.sos]);
      }
      // il nastro
      let rL: number, rR: number;
      if (nSrc === 0) {
        rL = mL;
        rR = mR;
      } else if (nSrc === 1) {
        rL = this.qL;
        rR = this.qR;
      } else if (nSrc === 2) {
        rL = pL;
        rR = pR;
      } else {
        rL = pL * mOper + this.qL * mQuinc + mL * mVoce;
        rR = pR * mOper + this.qR * mQuinc + mR * mVoce;
      }
      reel.process(rL * nGain, rR * nGain, ctl);
      let nL = reel.outL,
        nR = reel.outR;
      if (padSrc === 1) {
        pad.process(nL, nR, this.padOn || padHold, padMode, this.padX, this.padY, padMix, beat);
        nL = pad.outL;
        nR = pad.outR;
      }
      this.nL = nL;
      this.nR = nR;
      // quinconce
      const qa = q.process(chaos);
      for (let k = 0; k < 5; k++)
        if (q.rose[k]) {
          if (A.flip === k + 1) this.cocoA.flip();
          if (B.flip === k + 1) this.cocoB.flip();
          if (A.skip === k + 1) this.cocoA.skip(A.hz);
          if (B.skip === k + 1) this.cocoB.skip(B.hz);
        }
      let x: number;
      if (qSrc === 0) x = (mL + mR) * 0.5;
      else if (qSrc === 1) x = this.piezo.process(wood);
      else if (qSrc === 2) x = (nL + nR) * 0.5;
      else if (qSrc === 3) x = (pL + pR) * 0.5;
      else x = (pL + pR) * 0.5 * mOper + (nL + nR) * 0.5 * mNastro + (mL + mR) * 0.5 * mVoce;
      x += qa * qFeed;
      this.segui.run(x);
      const spA = A.spaf ? q.sq[A.spaf - 1] : 0,
        spB = B.spaf ? q.sq[B.spaf - 1] : 0;
      const hzA = A.hz * Math.pow(2, A.aff * 2.5 * clamp(spA + mod[D.aSpaf], -1, 1));
      const hzB = B.hz * Math.pow(2, B.aff * 2.5 * clamp(spB + mod[D.bSpaf], -1, 1));
      const ya = this.cocoA.process(x * A.inp, hzA, A.rec || !!gA, A.fb, A.dolby);
      const yb = this.cocoB.process((B.series ? ya : x) * B.inp, hzB, B.rec || !!gB, B.fb, B.dolby);
      if (Math.abs(ya) > this.lvlA) this.lvlA = Math.abs(ya);
      if (Math.abs(yb) > this.lvlB) this.lvlB = Math.abs(yb);
      let qL = ya * A.vol * aL + yb * B.vol * bL + qa * qVol,
        qR = ya * A.vol * aR + yb * B.vol * bR + qa * qVol;
      if (padSrc === 2) {
        pad.process(qL, qR, this.padOn || padHold, padMode, this.padX, this.padY, padMix, beat);
        qL = pad.outL;
        qR = pad.outR;
      }
      this.qL = qL;
      this.qR = qR;
      // the mixer
      let L = mL * mVoce + nL * mNastro + qL * mQuinc + pL * mOper,
        R = mR * mVoce + nR * mNastro + qR * mQuinc + pR * mOper;
      if (padSrc === 4) {
        pad.process(L, R, this.padOn || padHold, padMode, this.padX, this.padY, padMix, beat);
        L = pad.outL;
        R = pad.outR;
      }
      L *= mVol;
      R *= mVol;
      // a gentle limiter: anything above 0.9 is rounded off
      const pk = Math.max(Math.abs(L), Math.abs(R));
      const want = pk > 0.9 ? 0.9 / pk : 1;
      this.lim += (want - this.lim) * (want < this.lim ? 0.3 : 0.0004);
      L = tanh(L * this.lim);
      R = tanh(R * this.lim);
      oL[i] = L;
      oR[i] = R;
      if (Math.abs(L) > this.meterL) this.meterL = Math.abs(L);
      if (Math.abs(R) > this.meterR) this.meterR = Math.abs(R);
    }
    if (reel.full) {
      reel.full = false;
      this.send({ t: 'full' });
    }
    if (seq.changed >= 0) {
      this.send({ t: 'pat', i: seq.changed, row: seq.songRow });
      seq.changed = -1;
    }
    this.post(n);
    return true;
  }

  /** a rising edge at a gate destination */
  edge(dst: number) {
    const reel = this.reel;
    switch (dst) {
      case D.clk:
        if (++this.clkCount % [1, 2, 4, 8][this.p[G['n.clkdiv']] | 0] === 0) reel.clock();
        break;
      case D.rec:
        reel.recToggle();
        this.dirty = true;
        break;
      case D.splice:
        reel.splice();
        this.dirty = true;
        break;
      case D.shift:
        reel.shift();
        break;
      case D.aFlip:
        this.cocoA.flip();
        break;
      case D.aSkip:
        this.cocoA.skip(cocoHz(this.p[G['qa.speed']]));
        break;
      case D.bFlip:
        this.cocoB.flip();
        break;
      case D.bSkip:
        this.cocoB.skip(cocoHz(this.p[G['qb.speed']]));
        break;
    }
  }

  post(n: number) {
    const reel = this.reel,
      t = reel.tape;
    // the reel's picture: after every edit, and while recording
    this.ovT -= n;
    if (t.edits !== this.seenEdits || reel.cur !== this.seenCur || (reel.rec && this.ovT <= 0)) {
      if (t.edits !== this.seenEdits) this.dirty = true;
      this.seenEdits = t.edits;
      this.seenCur = reel.cur;
      this.ovT = Math.round(SR * 0.25);
      const ov = t.overview(1200);
      const [s0, s1] = t.count ? t.bounds(reel.cur) : [0, 0];
      const sov = t.overview(600, s0, Math.max(s0 + 1, s1));
      this.send({ t: 'reel', ov, sov, marks: [...t.marks], len: t.len, sr: SR, cap: t.cap, cur: reel.cur }, [ov.buffer, sov.buffer]);
    }
    if (this.dirty && !reel.rec) {
      this.dirtyT += n;
      if (this.dirtyT > SR * 0.5) {
        this.dirty = false;
        this.dirtyT = 0;
        this.send({ t: 'dirty' });
      }
    }
    this.monT -= n;
    if (this.monT > 0) return;
    this.monT = MON_EVERY;
    const seq = this.op.seq;
    const steps: number[] = [];
    for (let k = 0; k < 16; k++) steps.push(seq.playing ? seq.where(k).step : -1);
    const m: Mon = {
      t: 'mon',
      playing: seq.playing,
      cur: seq.cur,
      songRow: seq.songRow,
      steps,
      levels: this.op.levels(),
      reel: reel.mon(),
      coco: [this.cocoA.where, this.cocoB.where],
      cocoLvl: [this.lvlA, this.lvlB],
      petals: Array.from(this.q.sq),
      held: Array.from(this.q.sh),
      pad: this.pad.eng,
      out: [this.meterL, this.meterR],
      inp: this.meterIn,
      cv: Array.from(this.cv),
      gates: Array.from(this.high),
    };
    this.meterL = this.meterR = this.meterIn = 0;
    this.lvlA *= 0.5;
    this.lvlB *= 0.5;
    this.send(m);
  }
}

registerProcessor('genoma', Genoma);
