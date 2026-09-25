import { VERT, SIM, DRAW } from './shaders';
import { ACORN, GLIDER, GOSPER_GUN, R_PENTOMINO, cells, size, type Pattern } from './patterns';

export interface Rule {
  name: string;
  code: string;
  birth: number[];
  survive: number[];
}

export const RULES: Rule[] = [
  { name: 'Conway', code: 'B3/S23', birth: [3], survive: [2, 3] },
  { name: 'HighLife', code: 'B36/S23', birth: [3, 6], survive: [2, 3] },
  { name: 'Day & Night', code: 'B3678/S34678', birth: [3, 6, 7, 8], survive: [3, 4, 6, 7, 8] },
  { name: 'Anneal', code: 'B4678/S35678', birth: [4, 6, 7, 8], survive: [3, 5, 6, 7, 8] },
];

/** Parse "B3/S23" (also "b36s23", "B3678/S34678"). Returns null if malformed. */
export function parseRule(code: string): Rule | null {
  const m = code.trim().toUpperCase().match(/^B([0-8]*)\/?S([0-8]*)$/);
  if (!m) return null;
  const digits = (d: string) => [...new Set([...d].map(Number))].sort();
  const birth = digits(m[1]), survive = digits(m[2]);
  const known = RULES.find((r) => r.birth.join() === birth.join() && r.survive.join() === survive.join());
  return known ?? { name: 'Custom', code: `B${birth.join('')}/S${survive.join('')}`, birth, survive };
}

export type Mode = 'hero' | 'ambient';

export interface Stats {
  gen: number;
  pop: number;
  density: number;
  /** Shannon entropy of 2×2 blocks, normalised to [0, 1]. */
  entropy: number;
  rule: Rule;
  running: boolean;
}

const MODE = {
  hero: { intensity: 1, gps: 14 },
  ambient: { intensity: 0.34, gps: 8 },
} as const;

const mask = (ns: number[]) => ns.reduce((m, n) => m | (1 << n), 0);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Life {
  readonly gl: WebGL2RenderingContext;
  private sim!: WebGLProgram;
  private draw!: WebGLProgram;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private near!: WebGLSampler;
  private soft!: WebGLSampler;
  private cur = 0;
  private W = 0;
  private H = 0;
  private cellCss = 6;
  private dpr = 1;

  private ruleIndex = 0;
  private custom: Rule | null = null;
  private stepHooks = new Set<(gen: number) => void>();
  /** Screen-space y (CSS px) of the sonification scanline, or -1 when off. */
  probeY = -1;
  private gen = 0;
  private acc = 0;
  private last = 0;
  private holdUntil = 0;
  private raf = 0;
  private mode: Mode = 'ambient';
  private intensity = 0.42;
  private mouse = { x: -1e4, y: -1e4, lens: 0, target: 0 };
  private statsBuf = new Uint8Array(0);
  private lastStats: Stats | null = null;
  private listeners = new Set<(s: Stats) => void>();

  running: boolean;
  /** Set while reading below the hero: the colony recedes to ambient strength. */
  receded = false;
  /** Multipliers driven by the homeostat (1 = neutral). */
  tempo = 1;
  vividness = 1;

  constructor(private canvas: HTMLCanvasElement, opts: { reducedMotion: boolean }) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.running = !opts.reducedMotion;
    this.init();
    this.resize();
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stopLoop() : this.startLoop()));
    this.startLoop();
  }

  // ── setup ────────────────────────────────────────────────────────────────

  private compile(fsrc: string) {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
  }

  private init() {
    const gl = this.gl;
    this.sim = this.compile(SIM);
    this.draw = this.compile(DRAW);
    this.near = gl.createSampler()!;
    this.soft = gl.createSampler()!;
    for (const [s, f] of [[this.near, gl.NEAREST], [this.soft, gl.LINEAR]] as const) {
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, f);
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, f);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
  }

  /**
   * The grid is sized to the whole *screen*, not the window, so resizing the
   * window (or a mobile URL bar collapsing) only changes how much of the colony
   * is visible — it never has to be rebuilt.
   */
  private resize() {
    const gl = this.gl;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.cellCss = innerWidth < 640 ? 5 : 6;
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    const W = Math.ceil(Math.max(innerWidth, screen.width) / this.cellCss);
    const H = Math.ceil(Math.max(innerHeight, screen.height) / this.cellCss);
    if (W <= this.W && H <= this.H) return this.render();

    this.W = Math.max(W, this.W);
    this.H = Math.max(H, this.H);
    for (const t of this.tex) gl.deleteTexture(t);
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = [];
    this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      this.fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.seed(this.pendingText);
  }

  // ── seeding & editing ────────────────────────────────────────────────────

  private pendingText: string | undefined;

  /** Visible window in cells. */
  get view() {
    return { w: Math.ceil(innerWidth / this.cellCss), h: Math.ceil(innerHeight / this.cellCss) };
  }

  /** Reset the colony. With `text`, the text is drawn in live cells and held still for a beat. */
  seed(text?: string) {
    this.pendingText = text;
    const { W, H } = this;
    if (!W) return;
    const data = new Uint8Array(W * H * 4);
    const set = (x: number, y: number) => {
      const i = ((((y % H) + H) % H) * W + (((x % W) + W) % W)) * 4;
      data[i] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    };
    const { w: vw, h: vh } = this.view;

    if (text) {
      const c = document.createElement('canvas');
      c.width = vw;
      c.height = vh;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      const px = Math.min(vh * 0.62, (vw * 0.9) / (text.length * 0.55));
      x.font = `italic ${px}px "Instrument Serif", Georgia, serif`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = '#fff';
      const cx = vw > 900 / this.cellCss ? vw * 0.62 : vw * 0.5;
      x.fillText(text, cx, vh * 0.5);
      const img = x.getImageData(0, 0, vw, vh).data;
      for (let y = 0; y < vh; y++) for (let xx = 0; xx < vw; xx++) if (img[(y * vw + xx) * 4] > 110) set(xx, y);
      // a few long-lived perturbations away from the text
      for (let i = 0; i < 9; i++) {
        const ax = Math.floor((i % 2 ? rand(0.02, 0.3) : rand(0.3, 0.98)) * vw);
        const ay = Math.floor((i % 2 ? rand(0.1, 0.9) : rand(0.05, 0.2)) * vh);
        for (const [dx, dy] of cells(ACORN, Math.random() < 0.5, Math.random() < 0.5)) set(ax + dx, ay + dy);
      }
      // off-screen soup keeps gliders drifting in long after the text is gone
      for (let k = 0; k < 10; k++) {
        const pw = rand(12, 30), ph = rand(10, 24);
        const ox = vw + rand(0, Math.max(1, W - vw - pw)), oy = rand(0, H - ph);
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (Math.random() < 0.32) set(Math.floor(ox + x), Math.floor(oy + y));
      }
      this.holdUntil = performance.now() + 1600;
    } else {
      // soup in a handful of patches
      for (let k = 0; k < 14; k++) {
        const pw = rand(10, 40), ph = rand(8, 30);
        const ox = rand(0, W - pw), oy = rand(0, H - ph);
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (Math.random() < 0.3) set(Math.floor(ox + x), Math.floor(oy + y));
      }
      this.holdUntil = 0;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.gen = 0;
    this.render();
    this.sample();
  }

  /** Stamp a pattern with its top-left at cell (x, y); clears the bounding box first. */
  stamp(p: Pattern, x: number, y: number, flipX = false, flipY = false) {
    const [w, h] = size(p);
    x = Math.max(0, Math.min(this.W - w, Math.round(x - w / 2)));
    y = Math.max(0, Math.min(this.H - h, Math.round(y - h / 2)));
    const data = new Uint8Array(w * h * 4);
    for (const [cx, cy] of cells(p, flipX, flipY)) data.set([255, 0, 255, 255], (cy * w + cx) * 4);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.render();
  }

  /** Paint a small brush of live cells at a CSS-pixel position. */
  paint(px: number, py: number) {
    const x = Math.floor(px / this.cellCss), y = Math.floor(py / this.cellCss);
    this.stamp(['OO', 'OO'], x + 1, y + 1);
  }

  dropAt(px: number, py: number, kind: 'glider' | 'gun' | 'meteor') {
    const x = px / this.cellCss, y = py / this.cellCss;
    const fx = Math.random() < 0.5, fy = Math.random() < 0.5;
    this.stamp(kind === 'gun' ? GOSPER_GUN : kind === 'meteor' ? R_PENTOMINO : GLIDER, x, y, fx, fy);
  }

  // ── controls ─────────────────────────────────────────────────────────────

  setMode(mode: Mode, text?: string) {
    const changed = mode !== this.mode;
    this.mode = mode;
    if (text) this.seed(text);
    else if (changed && mode === 'ambient' && this.lastStats && this.lastStats.density < 0.01) this.seed();
  }

  setRule(i: number) {
    this.custom = null;
    this.ruleIndex = ((i % RULES.length) + RULES.length) % RULES.length;
    this.emit();
  }
  cycleRule() {
    this.setRule(this.ruleIndex + 1);
  }
  /** Any Life-like rule, e.g. "B36/S23". Returns false if the code doesn't parse. */
  setRuleCode(code: string) {
    const r = parseRule(code);
    if (!r) return false;
    this.custom = r;
    this.emit();
    return true;
  }
  get rule() {
    return this.custom ?? RULES[this.ruleIndex];
  }

  toggle(run = !this.running) {
    this.running = run;
    this.holdUntil = 0;
    this.emit();
  }

  pointer(x: number, y: number, active: boolean) {
    this.mouse.x = x * this.dpr;
    this.mouse.y = y * this.dpr;
    this.mouse.target = active ? 1 : 0;
  }

  onStep(fn: (gen: number) => void) {
    this.stepHooks.add(fn);
    return () => this.stepHooks.delete(fn);
  }

  /** Live cells along one screen row (CSS px), left to right. Cheap: one row readback. */
  probeRow(yCss: number): Uint8Array {
    const gl = this.gl;
    const { w } = this.view;
    const vw = Math.min(w, this.W);
    const y = Math.max(0, Math.min(this.H - 1, Math.floor(yCss / this.cellCss)));
    const buf = new Uint8Array(vw * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readPixels(0, y, vw, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Uint8Array(vw);
    for (let i = 0; i < vw; i++) out[i] = buf[i * 4] > 127 ? 1 : 0;
    return out;
  }

  /** Stamp any pattern given as rows of `O`/`.` at a CSS-pixel position. */
  stampAt(p: Pattern, px: number, py: number, flipX = false, flipY = false) {
    this.stamp(p, px / this.cellCss, py / this.cellCss, flipX, flipY);
  }

  get generation() {
    return this.gen;
  }

  onStats(fn: (s: Stats) => void) {
    this.listeners.add(fn);
    if (this.lastStats) fn(this.lastStats);
    return () => this.listeners.delete(fn);
  }

  // ── loop ─────────────────────────────────────────────────────────────────

  private startLoop() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(now - this.last, 100);
      this.last = now;
      const target = MODE[this.mode];
      const want = (this.receded ? Math.min(target.intensity, MODE.ambient.intensity) : target.intensity) * this.vividness;
      this.intensity += (want - this.intensity) * Math.min(1, dt / 400);
      this.mouse.lens += (this.mouse.target - this.mouse.lens) * Math.min(1, dt / 180);

      if (this.running && now > this.holdUntil) {
        this.acc += (dt / 1000) * target.gps * this.tempo;
        let n = 0;
        while (this.acc >= 1 && n++ < 3) {
          this.acc -= 1;
          this.step();
        }
      }
      this.render();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  step() {
    const gl = this.gl;
    const next = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[next]);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.sim);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.bindSampler(0, this.near);
    gl.uniform1i(gl.getUniformLocation(this.sim, 'uState'), 0);
    gl.uniform2i(gl.getUniformLocation(this.sim, 'uSize'), this.W, this.H);
    gl.uniform1i(gl.getUniformLocation(this.sim, 'uBirth'), mask(this.rule.birth));
    gl.uniform1i(gl.getUniformLocation(this.sim, 'uSurvive'), mask(this.rule.survive));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = next;
    this.gen++;
    this.stepHooks.forEach((fn) => fn(this.gen));
    if (this.gen % 15 === 0) this.sample();
  }

  render() {
    const gl = this.gl;
    if (!this.tex.length) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.draw);
    const u = (n: string) => gl.getUniformLocation(this.draw, n);
    for (const [unit, sampler] of [[0, this.near], [1, this.soft]] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
      gl.bindSampler(unit, sampler);
    }
    gl.uniform1i(u('uNear'), 0);
    gl.uniform1i(u('uSoft'), 1);
    gl.uniform2f(u('uRes'), this.canvas.width, this.canvas.height);
    gl.uniform2f(u('uGrid'), this.W, this.H);
    gl.uniform1f(u('uCell'), this.cellCss * this.dpr);
    gl.uniform2f(u('uMouse'), this.mouse.x, this.mouse.y);
    gl.uniform1f(u('uLens'), this.mouse.lens);
    gl.uniform1f(u('uLensR'), 120 * this.dpr);
    gl.uniform1f(u('uIntensity'), this.intensity);
    gl.uniform1f(u('uProbe'), this.probeY < 0 ? -1 : this.probeY * this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read back the visible window and measure it. ~1 Hz, so the stall is harmless. */
  private sample() {
    const gl = this.gl;
    const { w, h } = this.view;
    const vw = Math.min(w, this.W), vh = Math.min(h, this.H);
    if (this.statsBuf.length < vw * vh * 4) this.statsBuf = new Uint8Array(vw * vh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readPixels(0, 0, vw, vh, gl.RGBA, gl.UNSIGNED_BYTE, this.statsBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const b = this.statsBuf;
    const alive = (x: number, y: number) => (b[(y * vw + x) * 4] > 127 ? 1 : 0);
    let pop = 0;
    for (let i = 0; i < vw * vh; i++) pop += b[i * 4] > 127 ? 1 : 0;
    const counts = new Uint32Array(16);
    let blocks = 0;
    for (let y = 0; y + 1 < vh; y += 2)
      for (let x = 0; x + 1 < vw; x += 2) {
        counts[alive(x, y) | (alive(x + 1, y) << 1) | (alive(x, y + 1) << 2) | (alive(x + 1, y + 1) << 3)]++;
        blocks++;
      }
    let H = 0;
    for (const c of counts) if (c) H -= (c / blocks) * Math.log2(c / blocks);
    const density = pop / (vw * vh);
    this.lastStats = { gen: this.gen, pop, density, entropy: H / 4, rule: this.rule, running: this.running };
    this.emit();

    // keep the colony from settling into stillness
    if (this.running && this.gen > 0 && this.gen % 300 === 0 && density < 0.03) {
      this.stamp(ACORN, rand(0.1, 0.9) * vw, rand(0.1, 0.9) * vh, Math.random() < 0.5);
    }
  }

  private emit() {
    if (!this.lastStats) return;
    const s = { ...this.lastStats, gen: this.gen, rule: this.rule, running: this.running };
    this.listeners.forEach((fn) => fn(s));
  }
}
