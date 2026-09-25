/** Fullscreen triangle from gl_VertexID — no vertex buffers needed. */
export const VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * One generation of any outer-totalistic Moore-neighbourhood rule (Life-like).
 * State texel: r = alive, g = age while alive, b = heat (trail left by the dead).
 * Birth/survival are bitmasks: bit n set ⇔ n live neighbours triggers it.
 */
export const SIM = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uSize;
uniform int uBirth;
uniform int uSurvive;
out vec4 o;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = 0;
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = (p + ivec2(dx, dy) + uSize) % uSize;
      n += int(texelFetch(uState, q, 0).r > 0.5);
    }
  vec4 s = texelFetch(uState, p, 0);
  bool alive = s.r > 0.5;
  bool next = alive ? ((uSurvive >> n) & 1) == 1 : ((uBirth >> n) & 1) == 1;
  float age  = next && alive ? min(s.g + 4.0 / 255.0, 1.0) : 0.0;
  // subtract a floor so 8-bit rounding can't leave heat stuck above zero
  float heat = next ? 1.0 : max(s.b * 0.93 - 1.0 / 255.0, 0.0);
  o = vec4(next ? 1.0 : 0.0, age, heat, 1.0);
}`;

/**
 * Draws the colony: gapped square cells coloured by age, cobalt afterglow where
 * cells died, a cheap bloom from a linearly-filtered read of the same texture,
 * and a magnifying "scanner" lens that follows the pointer.
 */
export const DRAW = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uNear;
uniform sampler2D uSoft;
uniform vec2 uRes;
uniform vec2 uGrid;
uniform float uCell;
uniform vec2 uMouse;
uniform float uLens;
uniform float uLensR;
uniform float uIntensity;
out vec4 o;

const vec3 VOID   = vec3(0.039, 0.039, 0.043);
const vec3 ACID   = vec3(0.776, 1.000, 0.239);
const vec3 GHOST  = vec3(0.490, 0.549, 1.000);
const vec3 COBALT = vec3(0.184, 0.271, 1.000);
const vec3 BONE   = vec3(0.925, 0.898, 0.827);

vec3 living(float age) {
  vec3 c = mix(ACID, GHOST, smoothstep(0.0, 0.3, age));
  return mix(c, BONE * 0.42, smoothstep(0.3, 1.0, age));
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);

  // scanner lens: pull sample positions toward the pointer to magnify
  vec2 d = frag - uMouse;
  float r = length(d);
  float k = uLens * smoothstep(uLensR, 0.0, r);
  vec2 q = uMouse + d * (1.0 - 0.5 * k * k);

  vec2 g = q / uCell;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec4 s = texelFetch(uNear, ivec2(mod(cell, uGrid)), 0);

  vec2 e = abs(f - 0.5);
  float box = 1.0 - smoothstep(0.34, 0.42, max(e.x, e.y));

  vec3 col = VOID;
  float heat = s.r > 0.5 ? 0.0 : s.b;
  col += COBALT * pow(heat, 2.0) * 0.32;
  col = mix(col, living(s.g), box * step(0.5, s.r));

  vec2 uv = g / uGrid;
  vec2 px = 1.6 / uGrid;
  float glow = texture(uSoft, uv + vec2(px.x, 0.0)).r + texture(uSoft, uv - vec2(px.x, 0.0)).r
             + texture(uSoft, uv + vec2(0.0, px.y)).r + texture(uSoft, uv - vec2(0.0, px.y)).r
             + texture(uSoft, uv + px).r + texture(uSoft, uv - px).r
             + texture(uSoft, uv + vec2(px.x, -px.y)).r + texture(uSoft, uv + vec2(-px.x, px.y)).r;
  col += mix(ACID, GHOST, 0.5) * glow * 0.022;

  col = VOID + (col - VOID) * uIntensity;

  // lens rim + inner tint
  float rim = uLens * (smoothstep(1.6, 0.0, abs(r - uLensR)) * 0.55 + k * 0.05);
  col += ACID * rim * max(uIntensity, 0.5);

  vec2 n = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - dot(n, n) * 0.7;
  o = vec4(col, 1.0);
}`;
