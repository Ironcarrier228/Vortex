/**
 * GradePass — финальный проход пост-обработки: цветокоррекция, виньетка, зерно,
 * хроматические аберрации и — главное — «пролёт» между сценами.
 *
 * Пролёт устроен так: уходящая сцена рендерится в отдельный target, приходящая идёт
 * по обычной цепочке (Render → Bloom → этот проход), а шейдер смешивает два изображения
 * по прогрессу + добавляет радиальный варп и вспышку. Получается «камера летит сквозь
 * пространство» вместо простого кроссфейда.
 */

import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D uPrev;
uniform float uMix;
uniform float uWarp;
uniform float uFlash;
uniform float uTime;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uChroma;
uniform float uVignette;
uniform float uGrain;
varying vec2 vUv;

// ACES-тонмаппинг: даёт «киношный» вид и не выжигает неоновые пики в белый.
vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Радиальный варп: ближе к центру сильнее закрутка, по краям — «линзовое» растяжение.
vec2 warp(vec2 uv, float amount) {
  vec2 center = uv - 0.5;
  float radius = length(center);
  float k = amount * 0.55;
  float angle = k * (1.0 - radius) * 3.2;
  float scale = 1.0 - k * 0.28 * radius;
  vec2 rotated = vec2(
    center.x * cos(angle) - center.y * sin(angle),
    center.x * sin(angle) + center.y * cos(angle)
  ) * scale;
  return rotated + 0.5;
}

void main() {
  vec2 uv = vUv;
  vec2 warped = warp(uv, uWarp);

  vec3 color = texture2D(tDiffuse, warped).rgb;

  if (uMix > 0.0005) {
    vec3 previous = texture2D(uPrev, warp(uv, -uWarp * 1.4)).rgb;
    color = mix(previous, color, smoothstep(0.0, 1.0, uMix));
  }

  if (uChroma > 0.0005) {
    vec2 dir = uv - 0.5;
    float amount = uChroma * 0.02 * dot(dir, dir) * 4.0;
    color.r = texture2D(tDiffuse, warped + dir * amount).r;
    color.b = texture2D(tDiffuse, warped - dir * amount).b;
    color *= 0.5 + 0.5 * uChroma;
  }

  color *= uExposure;
  color = aces(color);
  color = (color - 0.5) * uContrast + 0.5;

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, uSaturation);

  // Вспышка перехода: мягкий кольцевой импульс к центру.
  color += uFlash * vec3(0.35, 0.62, 1.0) * pow(1.0 - length(uv - 0.5) * 1.6, 2.0);

  // Виньетка.
  float radius = length(uv - 0.5) * 1.41421;
  float vignette = mix(1.0, smoothstep(1.15, 0.28, radius), clamp(uVignette, 0.0, 1.0));
  color *= vignette;

  // Плёночное зерно: убирает «пластиковость» градиентов.
  float noise = fract(sin(dot(uv * 1024.0 + uTime * 13.0, vec2(12.9898, 78.233))) * 43758.5453);
  color += (noise - 0.5) * uGrain * 0.14;

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

export class GradePass extends Pass {
  readonly material: THREE.ShaderMaterial;
  #quad: FullScreenQuad;

  constructor() {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uPrev: { value: null },
        uMix: { value: 0 },
        uWarp: { value: 0 },
        uFlash: { value: 0 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uExposure: { value: 1.08 },
        uContrast: { value: 1.04 },
        uSaturation: { value: 1.12 },
        uChroma: { value: 0.35 },
        uVignette: { value: 0.42 },
        uGrain: { value: 0.05 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.#quad = new FullScreenQuad(this.material);
  }

  override setSize(width: number, height: number): void {
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.#quad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.#quad.render(renderer);
    }
  }

  override dispose(): void {
    this.#quad.dispose();
    this.material.dispose();
  }
}
