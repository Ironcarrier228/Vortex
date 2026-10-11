/**
 * GLSL аудиовизуализатора.
 *
 * Важный принцип: вся анимация частиц и поверхности считается на GPU. Во фронтенде
 * каждый кадр передаётся только 64-байтовая текстура спектра и несколько скаляров,
 * поэтому 150 000 частиц не мешают держать 60 FPS.
 */


/** Частицы: позиция и цвет считаются в вершинном шейдере из спектральной текстуры. */
export const PARTICLES_VERTEX = /* glsl */ `
precision highp float;

attribute vec4 aSeed;   // x: фаза, y: радиус, z: скорость/группа, w: индекс полосы (0..1)
attribute vec3 aDir;    // направление на сфере (единичный вектор)

uniform sampler2D uBand;
uniform float uTime;
uniform float uBass;
uniform float uEnergy;
uniform float uBeat;
uniform float uSize;
uniform float uPixelRatio;
uniform float uSpread;

varying vec3 vColor;
varying float vAlpha;

// Тёплая палитра: циан → янтарь → розовый (совпадает с heatPalette в TS).
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cyan = vec3(0.13, 0.83, 0.93);
  vec3 amber = vec3(0.98, 0.75, 0.14);
  vec3 pink = vec3(0.96, 0.45, 0.71);
  return t < 0.55 ? mix(cyan, amber, t / 0.55) : mix(amber, pink, (t - 0.55) / 0.45);
}

void main() {
  float band = texture2D(uBand, vec2(aSeed.w, 0.5)).r;

  // Орбитальное вращение + вертикальный дрейф: поле постоянно «живёт».
  float angle = uTime * (0.12 + aSeed.z * 0.35) + aSeed.x * 6.2831;
  float radius = aSeed.y * (1.0 + band * 1.5 + uBeat * 0.9) * uSpread;

  vec3 dir = aDir;
  float cosA = cos(angle);
  float sinA = sin(angle);
  vec3 orbit = vec3(dir.x * cosA - dir.z * sinA, dir.y, dir.x * sinA + dir.z * cosA);

  // Волна «дыхания» по вертикали, усиленная басом.
  orbit.y += sin(uTime * 0.8 + aSeed.x * 12.0) * (0.12 + uBass * 0.5);

  vec3 pos = orbit * radius;
  // Сферическая оболочка сжимается на энергии — визуальный «вдох/выдох».
  pos *= 1.0 - uEnergy * 0.12 + band * 0.35;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = uSize * (0.4 + band * 1.9 + uBeat * 0.8) * (300.0 / max(-mv.z, 0.001));
  gl_PointSize = size * uPixelRatio;

  vColor = heat(band * 0.85 + aSeed.z * 0.25);
  vAlpha = clamp(0.12 + band * 1.4, 0.0, 1.0);
}
`;

export const PARTICLES_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;

void main() {
  // Мягкая круглая точка: гауссиана вместо жёсткого квадрата.
  vec2 uv = gl_PointCoord - 0.5;
  float d = dot(uv, uv);
  if (d > 0.25) discard;
  float alpha = exp(-d * 11.0) * vAlpha * uOpacity;
  gl_FragColor = vec4(vColor * (0.6 + vAlpha * 0.8) * uOpacity, alpha);
}
`;

/** Тоннель: спектр по углу, бегущие полосы по глубине. */
export const TUNNEL_VERTEX = /* glsl */ `
precision highp float;

uniform sampler2D uBand;
uniform float uTime;
uniform float uBeat;
uniform float uRadius;

varying vec2 vUv;
varying float vBand;
varying float vDepth;

void main() {
  vUv = uv;
  float band = texture2D(uBand, vec2(uv.x, 0.5)).r;
  vBand = band;

  // Радиальное «дыхание» стенок тоннеля под музыку.
  float bulge = 1.0 + band * 0.34 + uBeat * 0.12 - (1.0 - abs(uv.y - 0.5) * 2.0) * 0.06;
  vec3 pos = position;
  pos.xz *= bulge * uRadius;

  // Лёгкая закрутка вдоль оси движения.
  float twist = uTime * 0.25 + uv.y * 2.0;
  float c = cos(twist);
  float s = sin(twist);
  pos.xz = mat2(c, -s, s, c) * pos.xz;
  pos.y += uv.y * 6.0;

  vDepth = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const TUNNEL_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uEnergy;
uniform float uBeat;
uniform float uOpacity;

varying vec2 vUv;
varying float vBand;
varying float vDepth;

vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cyan = vec3(0.13, 0.83, 0.93);
  vec3 violet = vec3(0.65, 0.55, 0.98);
  vec3 pink = vec3(0.96, 0.45, 0.71);
  return t < 0.5 ? mix(cyan, violet, t * 2.0) : mix(violet, pink, (t - 0.5) * 2.0);
}

void main() {
  // Бегущие кольца: смещение по глубине с учётом энергии кадра.
  float speed = 14.0 + uEnergy * 26.0;
  float rings = fract(vDepth * 26.0 - uTime * speed);
  float ring = smoothstep(0.86, 1.0, rings) + smoothstep(0.12, 0.0, rings);
  // Продольные линии по углу.
  float spokes = smoothstep(0.86, 1.0, fract(vUv.x * 48.0)) * 0.35;

  float glow = ring * (0.55 + vBand * 2.2) + spokes * (0.25 + vBand);
  // Затухание в глубине тоннеля.
  float fade = smoothstep(0.0, 0.35, vDepth) * smoothstep(1.0, 0.7, vDepth);

  vec3 color = heat(vBand * 0.8 + 0.1) * glow * fade;
  color += vec3(0.35, 0.15, 0.5) * uBeat * 0.4 * fade;

  gl_FragColor = vec4(color * uOpacity, clamp(glow * fade * 0.9, 0.0, 1.0) * uOpacity);
}
`;

/** Деформируемая сфера: шум + спектр + френель. */
export const SPHERE_VERTEX = /* glsl */ `
precision highp float;

uniform sampler2D uBand;
uniform float uTime;
uniform float uBass;
uniform float uEnergy;
uniform float uBeat;
uniform float uDisplace;

varying float vDisplacement;
varying vec3 vNormalView;
varying vec3 vPositionView;
varying float vBand;

// --- Компактный 3D-симплекс-шум (Ashima Arts, MIT) ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  // Полоса по широте: низ сферы реагирует на бас, верх — на высокие частоты.
  float bandIndex = clamp((normal.y * 0.5 + 0.5), 0.0, 1.0);
  float band = texture2D(uBand, vec2(bandIndex, 0.5)).r;
  vBand = band;

  float noise = snoise(normal * 2.6 + vec3(0.0, uTime * 0.22, uTime * 0.13));
  float detail = snoise(normal * 7.5 - vec3(uTime * 0.35, 0.0, 0.0)) * 0.35;

  float displacement = (noise + detail) * (0.24 + band * 0.75 + uBass * 0.55) + uBeat * 0.14;
  displacement *= uDisplace;

  vDisplacement = displacement;

  vec3 transformed = position + normal * displacement;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);

  vNormalView = normalize(normalMatrix * normal);
  vPositionView = mvPosition.xyz;

  gl_Position = projectionMatrix * mvPosition;
}
`;

export const SPHERE_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uEnergy;
uniform float uBeat;
uniform float uOpacity;

varying float vDisplacement;
varying vec3 vNormalView;
varying vec3 vPositionView;
varying float vBand;

vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cyan = vec3(0.13, 0.83, 0.93);
  vec3 violet = vec3(0.65, 0.55, 0.98);
  vec3 pink = vec3(0.96, 0.45, 0.71);
  return t < 0.5 ? mix(cyan, violet, t * 2.0) : mix(violet, pink, (t - 0.5) * 2.0);
}

void main() {
  vec3 normal = normalize(vNormalView);
  vec3 viewDir = normalize(-vPositionView);

  // Френель: яркая кромка, тёмный центр — «энергетический пузырь».
  float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.4);

  // Псевдо-освещение: направленный источник сверху-слева + подсветка снизу.
  float diffuse = clamp(dot(normal, normalize(vec3(-0.6, 0.8, 0.5))), 0.0, 1.0);
  vec3 base = heat(vDisplacement * 1.6 + vBand * 0.5);
  vec3 color = base * (0.25 + diffuse * 0.7) + base * fresnel * (1.6 + uEnergy * 1.4);

  // Гребни волн подсвечиваются сильнее — читается структура деформации.
  color += heat(vBand) * smoothstep(0.35, 1.0, abs(vDisplacement)) * 0.9;
  color += vec3(0.4, 0.7, 1.0) * uBeat * 0.25;

  gl_FragColor = vec4(color * uOpacity, uOpacity);
}
`;

/** Спектр: «зеркальный» пол с бегущей волной от низа колонн. */
export const FLOOR_VERTEX = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FLOOR_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uBand;
uniform float uTime;
uniform float uEnergy;
uniform float uOpacity;

varying vec2 vUv;

void main() {
  // Спектр, «отражённый» в полу.
  float band = texture2D(uBand, vec2(vUv.x, 0.5)).r;
  float line = smoothstep(0.4, 1.0, band) * (1.0 - vUv.y);

  // Сетка, уходящая в перспективу.
  float gridX = smoothstep(0.9, 1.0, fract(vUv.x * 64.0));
  float gridY = smoothstep(0.92, 1.0, fract(vUv.y * 26.0 - uTime * 0.35));
  float grid = (gridX * 0.14 + gridY * 0.2) * (0.25 + uEnergy);

  vec3 color = vec3(0.1, 0.55, 0.95) * line * 0.6 + vec3(0.2, 0.7, 0.95) * grid;
  gl_FragColor = vec4(color, (line * 0.55 + grid) * uOpacity);
}
`;
