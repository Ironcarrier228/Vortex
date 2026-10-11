/**
 * Общие материалы и текстуры для всех сцен: единая палитра и «глубокий космос»
 * на фоне склеивают три разные визуализации в одно приложение.
 */

import * as THREE from 'three';

export const NEON = {
  cyan: new THREE.Color('#22d3ee'),
  violet: new THREE.Color('#a78bfa'),
  pink: new THREE.Color('#f472b6'),
  amber: new THREE.Color('#fbbf24'),
  green: new THREE.Color('#34d399'),
  blue: new THREE.Color('#3b82f6'),
};

/** Палитра «неон»: циан → фиолет → розовый (t в 0..1). */
export function neonPalette(t: number, target = new THREE.Color()): THREE.Color {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped < 0.5) {
    return target.copy(NEON.cyan).lerp(NEON.violet, clamped * 2);
  }
  return target.copy(NEON.violet).lerp(NEON.pink, (clamped - 0.5) * 2);
}

/** Тепловая палитра для «трафика»: спокойный циан → янтарный → розовый. */
export function heatPalette(t: number, target = new THREE.Color()): THREE.Color {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped < 0.55) {
    return target.copy(NEON.cyan).lerp(NEON.amber, clamped / 0.55);
  }
  return target.copy(NEON.amber).lerp(NEON.pink, (clamped - 0.55) / 0.45);
}

/**
 * Текстура спектра: 64 байта (0…255) по горизонтали.
 * Формат R8 линейно фильтруется во всех WebGL2-драйверах — шейдеры получают
 * интерполированный спектр без ручной выборки.
 */
export function makeBandTexture(bands = 64): { texture: THREE.DataTexture; data: Uint8Array } {
  const data = new Uint8Array(bands);
  const texture = new THREE.DataTexture(data, bands, 1, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, data };
}

/** Заполнить текстуру из нормализованного спектра 0..1. */
export function updateBandTexture(texture: THREE.DataTexture, data: Uint8Array, bands: Float32Array): void {
  const count = Math.min(data.length, bands.length);
  for (let i = 0; i < count; i++) {
    data[i] = Math.max(0, Math.min(255, (bands[i] * 255) | 0));
  }
  texture.needsUpdate = true;
}

/** Круглая мягкая точка (для спрайтов и additive-частиц). */
export function createGlowTexture(size = 128, hardness = 2.2): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let step = 0; step <= 10; step++) {
    const t = step / 10;
    const alpha = Math.pow(1 - t, hardness);
    gradient.addColorStop(t, `rgba(255,255,255,${alpha.toFixed(3)})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Фоновая сфера «космос»: очень тёмный градиент с медленными авроральными полосами.
 * Служит подложкой для всех сцен, чтобы не было плоского чёрного фона.
 */
export function createAuroraBackdrop(radius = 120): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uTint: { value: new THREE.Color('#0b1830') },
      uAccent: { value: new THREE.Color('#1d4f7c') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uEnergy;
      uniform vec3 uTint;
      uniform vec3 uAccent;
      varying vec3 vDir;

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      }

      void main() {
        // Три медленные «полосы» разной высоты — как аврора за горизонтом.
        float bands = 0.0;
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float wave = sin(vDir.x * (2.0 + fi) + uTime * (0.05 + fi * 0.03)) * 0.5 + 0.5;
          float height = smoothstep(-0.2, 0.9, vDir.y + (fi - 1.0) * 0.25);
          bands += wave * height * (0.5 - fi * 0.12);
        }
        float glow = smoothstep(0.55, -0.6, vDir.y) * 0.6;
        vec3 color = uTint + uAccent * (bands * (0.35 + uEnergy * 0.6) + glow * 0.35);
        color += hash(vDir * 60.0) * 0.012; // лёгкий шум против бандинга
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
