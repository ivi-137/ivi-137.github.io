/// <reference types="@webgpu/types" />
/**
 * Continuous cellular automata: Lenia and SmoothLife.
 *
 * State is a real number in [0,1] per cell. Each step convolves the field with
 * a radial kernel (a list of offsets with weights, precomputed once), then
 * applies a smooth growth function.
 *
 *   Lenia (Bert Chan, 2019)
 *     U = K ∗ A,  K(r) = exp(4 − 1/(r(1−r))) on the unit ring, normalised
 *     G(u) = 2·exp(−(u−μ)² / 2σ²) − 1
 *     A ← clip(A + Δt·G(U), 0, 1)
 *
 *   SmoothLife (Stephan Rafler, 2011)
 *     m = mean over the inner disk (radius rᵢ = rₐ/3), n = mean over the annulus
 *     s(n, m) = σ(n, lo(m)) · (1 − σ(n, hi(m))), lo/hi blend birth [0.278, 0.365]
 *     into survival [0.267, 0.445] as m goes from dead to alive
 *     A ← clip(A + Δt·(2s − 1), 0, 1)
 *
 * Primary backend: WebGPU compute shaders over storage buffers. Fallback:
 * WebGL2 fragment shaders over float textures.
 */

export type Kind = 'lenia' | 'smooth';
export interface Params {
  kind: Kind;
  R: number; // Lenia kernel radius / SmoothLife outer radius, in cells
  mu: number;
  sigma: number;
  dt: number;
}

export const PRESETS: Record<Kind, Params> = {
  lenia: { kind: 'lenia', R: 13, mu: 0.15, sigma: 0.015, dt: 0.1 },
  smooth: { kind: 'smooth', R: 12, mu: 0, sigma: 0, dt: 0.15 },
};

/** Offsets and weights, both channels normalised to sum to 1. */
export function kernel(p: Params): Float32Array {
  const out: number[] = [];
  const R = p.R;
  let s1 = 0, s2 = 0;
  const rows: Array<[number, number, number, number]> = [];
  for (let dy = -R - 1; dy <= R + 1; dy++)
    for (let dx = -R - 1; dx <= R + 1; dx++) {
      const r = Math.hypot(dx, dy);
      let w1 = 0, w2 = 0;
      if (p.kind === 'lenia') {
        const q = r / R;
        if (q > 0 && q < 1) w1 = Math.exp(4 - 1 / (q * (1 - q)));
      } else {
        const ri = R / 3;
        w1 = Math.min(1, Math.max(0, ri + 0.5 - r)); // anti-aliased inner disk
        w2 = Math.min(1, Math.max(0, r - ri + 0.5)) * Math.min(1, Math.max(0, R + 0.5 - r)); // annulus
      }
      if (w1 > 1e-6 || w2 > 1e-6) {
        rows.push([dx, dy, w1, w2]);
        s1 += w1;
        s2 += w2;
      }
    }
  for (const [dx, dy, w1, w2] of rows) out.push(dx, dy, s1 ? w1 / s1 : 0, s2 ? w2 / s2 : 0);
  return new Float32Array(out);
}

export function seedField(w: number, h: number, p: Params, at?: { x: number; y: number }): Float32Array {
  const a = new Float32Array(w * h);
  const blob = (cx: number, cy: number, rad: number) => {
    for (let y = -rad; y <= rad; y++)
      for (let x = -rad; x <= rad; x++) {
        if (x * x + y * y > rad * rad) continue;
        const i = ((((cy + y) % h) + h) % h) * w + ((((cx + x) % w) + w) % w);
        a[i] = p.kind === 'lenia' ? Math.random() : Math.random() < 0.55 ? 1 : 0;
      }
  };
  if (at) blob(at.x, at.y, Math.round(p.R * 1.1));
  else for (let k = 0; k < (p.kind === 'lenia' ? 7 : 14); k++) blob((Math.random() * w) | 0, (Math.random() * h) | 0, Math.round(p.R * (0.8 + Math.random() * 0.6)));
  return a;
}

/** A square patch holding one random blob, clipped to stay inside the grid. */
export function blobRect(w: number, h: number, p: Params, cx: number, cy: number) {
  const rad = Math.round(p.R * 1.1);
  const size = rad * 2 + 1;
  const x = Math.max(0, Math.min(w - size, cx - rad)), y = Math.max(0, Math.min(h - size, cy - rad));
  const data = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const dx = i - rad, dy = j - rad;
      if (dx * dx + dy * dy <= rad * rad) data[j * size + i] = p.kind === 'lenia' ? Math.random() : Math.random() < 0.55 ? 1 : 0;
    }
  return { x, y, size, data };
}

export interface Backend {
  name: 'WebGPU' | 'WebGL2';
  setParams(p: Params): void;
  upload(field: Float32Array): void;
  /** Overwrite a rectangle of the field (used to drop a new creature where you click). */
  stampRect(x: number, y: number, rw: number, rh: number, data: Float32Array): void;
  step(n: number): void;
  render(): void;
  destroy(): void;
}

// ── WebGPU ───────────────────────────────────────────────────────────────────

const WGSL = /* wgsl */ `
struct P { size: vec2u, count: u32, mode: u32, mu: f32, sigma: f32, dt: f32, pad: f32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> kern: array<vec4f>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

fn at(x: i32, y: i32) -> f32 {
  let w = i32(p.size.x); let h = i32(p.size.y);
  return src[u32(((y % h + h) % h) * w + ((x % w + w) % w))];
}
fn sig(x: f32, a: f32, al: f32) -> f32 { return 1.0 / (1.0 + exp(-(x - a) * 4.0 / al)); }

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.size.x || g.y >= p.size.y) { return; }
  let x = i32(g.x); let y = i32(g.y);
  var a = 0.0; var b = 0.0;
  for (var i = 0u; i < p.count; i++) {
    let k = kern[i];
    let v = at(x + i32(k.x), y + i32(k.y));
    a += v * k.z;
    b += v * k.w;
  }
  let here = at(x, y);
  var next: f32;
  if (p.mode == 0u) {
    let d = (a - p.mu) / p.sigma;
    next = here + p.dt * (2.0 * exp(-0.5 * d * d) - 1.0);
  } else {
    let am = sig(a, 0.5, 0.147);
    let lo = mix(0.278, 0.267, am);
    let hi = mix(0.365, 0.445, am);
    let s = sig(b, lo, 0.028) * (1.0 - sig(b, hi, 0.028));
    next = here + p.dt * (2.0 * s - 1.0);
  }
  dst[g.y * p.size.x + g.x] = clamp(next, 0.0, 1.0);
}

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}
@group(0) @binding(2) var<storage, read> field: array<f32>;
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let c = min(vec2u(in.uv * vec2f(p.size)), p.size - 1u);
  let v = field[c.y * p.size.x + c.x];
  return vec4f(palette(v), 1.0);
}
fn palette(v: f32) -> vec3f {
  let voidc = vec3f(0.039, 0.039, 0.043);
  let cobalt = vec3f(0.184, 0.271, 1.0);
  let acid = vec3f(0.776, 1.0, 0.239);
  let paper = vec3f(0.925, 0.898, 0.827);
  if (v < 0.35) { return mix(voidc, cobalt, smoothstep(0.0, 0.35, v)); }
  if (v < 0.75) { return mix(cobalt, acid, smoothstep(0.35, 0.75, v)); }
  return mix(acid, paper, smoothstep(0.75, 1.0, v));
}
`;

export async function webgpu(canvas: HTMLCanvasElement, w: number, h: number): Promise<Backend | null> {
  const gpu = (navigator as any).gpu as GPU | undefined;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) return null;
  const format = gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: WGSL });
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const fields = [0, 1].map(() => device.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  let kern = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let count = 0;

  const compute = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'step' } });
  const render = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  let cur = 0;
  let stepGroups: GPUBindGroup[] = [];
  let drawGroups: GPUBindGroup[] = [];
  const bind = () => {
    stepGroups = [0, 1].map((i) =>
      device.createBindGroup({
        layout: compute.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: kern } },
          { binding: 2, resource: { buffer: fields[i] } },
          { binding: 3, resource: { buffer: fields[1 - i] } },
        ],
      }),
    );
    drawGroups = [0, 1].map((i) =>
      device.createBindGroup({
        layout: render.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: fields[i] } },
        ],
      }),
    );
  };

  return {
    name: 'WebGPU',
    setParams(p) {
      const k = kernel(p);
      count = k.length / 4;
      kern.destroy();
      kern = device.createBuffer({ size: k.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(kern, 0, k);
      const u = new ArrayBuffer(32);
      new Uint32Array(u, 0, 4).set([w, h, count, p.kind === 'lenia' ? 0 : 1]);
      new Float32Array(u, 16, 4).set([p.mu, p.sigma, p.dt, 0]);
      device.queue.writeBuffer(uniform, 0, u);
      bind();
    },
    upload(field) {
      device.queue.writeBuffer(fields[cur], 0, field);
    },
    stampRect(x, y, rw, rh, data) {
      for (let r = 0; r < rh; r++) device.queue.writeBuffer(fields[cur], ((y + r) * w + x) * 4, data, r * rw, rw);
    },
    step(n) {
      const enc = device.createCommandEncoder();
      for (let i = 0; i < n; i++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(compute);
        pass.setBindGroup(0, stepGroups[cur]);
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
        cur = 1 - cur;
      }
      device.queue.submit([enc.finish()]);
    },
    render() {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(render);
      pass.setBindGroup(0, drawGroups[cur]);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      fields.forEach((b) => b.destroy());
      kern.destroy();
      uniform.destroy();
      device.destroy();
    },
  };
}

// ── WebGL2 fallback ─────────────────────────────────────────────────────────

const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const STEP_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc; uniform sampler2D uKern;
uniform ivec2 uSize; uniform int uCount; uniform int uMode;
uniform float uMu, uSigma, uDt;
out vec4 o;
float sig(float x, float a, float al) { return 1.0 / (1.0 + exp(-(x - a) * 4.0 / al)); }
float at(ivec2 q) { return texelFetch(uSrc, (q + uSize) % uSize, 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = 0.0, b = 0.0;
  for (int i = 0; i < 4096; i++) {
    if (i >= uCount) break;
    vec4 k = texelFetch(uKern, ivec2(i % 1024, i / 1024), 0);
    float v = at(p + ivec2(k.xy));
    a += v * k.z; b += v * k.w;
  }
  float here = at(p), next;
  if (uMode == 0) { float d = (a - uMu) / uSigma; next = here + uDt * (2.0 * exp(-0.5 * d * d) - 1.0); }
  else {
    float am = sig(a, 0.5, 0.147);
    float s = sig(b, mix(0.278, 0.267, am), 0.028) * (1.0 - sig(b, mix(0.365, 0.445, am), 0.028));
    next = here + uDt * (2.0 * s - 1.0);
  }
  o = vec4(clamp(next, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const DRAW_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes; uniform ivec2 uSize;
out vec4 o;
void main() {
  vec2 uv = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes;
  float v = texelFetch(uSrc, min(ivec2(uv * vec2(uSize)), uSize - 1), 0).r;
  vec3 voidc = vec3(0.039, 0.039, 0.043), cobalt = vec3(0.184, 0.271, 1.0), acid = vec3(0.776, 1.0, 0.239), paper = vec3(0.925, 0.898, 0.827);
  vec3 c = v < 0.35 ? mix(voidc, cobalt, smoothstep(0.0, 0.35, v)) : v < 0.75 ? mix(cobalt, acid, smoothstep(0.35, 0.75, v)) : mix(acid, paper, smoothstep(0.75, 1.0, v));
  o = vec4(c, 1.0);
}`;

export function webgl2(canvas: HTMLCanvasElement, w: number, h: number): Backend | null {
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  const prog = (fs: string) => {
    const p = gl.createProgram()!;
    for (const [t, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(t)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '');
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    return p;
  };
  const step = prog(STEP_FS), draw = prog(DRAW_FS);
  const tex = (tw: number, th: number, fmt: number, data: Float32Array | null, ch: number) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, tw, th, 0, ch, gl.FLOAT, data);
    return t;
  };
  const fields = [0, 1].map(() => tex(w, h, gl.R32F, null, gl.RED));
  const fbos = fields.map((t) => {
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  });
  let kern: WebGLTexture | null = null;
  let count = 0;
  let params: Params = PRESETS.lenia;
  let cur = 0;
  const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

  return {
    name: 'WebGL2',
    setParams(p) {
      params = p;
      const k = kernel(p);
      count = k.length / 4;
      const kw = Math.min(1024, count), kh = Math.ceil(count / 1024);
      const padded = new Float32Array(kw * kh * 4);
      padded.set(k);
      if (kern) gl.deleteTexture(kern);
      kern = tex(kw, kh, gl.RGBA32F, padded, gl.RGBA);
    },
    upload(field) {
      gl.bindTexture(gl.TEXTURE_2D, fields[cur]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, field);
    },
    stampRect(x, y, rw, rh, data) {
      gl.bindTexture(gl.TEXTURE_2D, fields[cur]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED, gl.FLOAT, data);
    },
    step(n) {
      gl.useProgram(step);
      gl.viewport(0, 0, w, h);
      gl.uniform2i(u(step, 'uSize'), w, h);
      gl.uniform1i(u(step, 'uCount'), count);
      gl.uniform1i(u(step, 'uMode'), params.kind === 'lenia' ? 0 : 1);
      gl.uniform1f(u(step, 'uMu'), params.mu);
      gl.uniform1f(u(step, 'uSigma'), params.sigma || 1);
      gl.uniform1f(u(step, 'uDt'), params.dt);
      gl.uniform1i(u(step, 'uSrc'), 0);
      gl.uniform1i(u(step, 'uKern'), 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, kern);
      for (let i = 0; i < n; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[1 - cur]);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fields[cur]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        cur = 1 - cur;
      }
    },
    render() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(draw);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fields[cur]);
      gl.uniform1i(u(draw, 'uSrc'), 0);
      gl.uniform2f(u(draw, 'uRes'), canvas.width, canvas.height);
      gl.uniform2i(u(draw, 'uSize'), w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
