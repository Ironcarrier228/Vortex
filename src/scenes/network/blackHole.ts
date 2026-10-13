/**
 * Чёрная дыра — «мусорка» сцены сети.
 *
 * Когда пользователь вырывает орб и **выкидывает** его (рывок кистью при отпускании),
 * перед ним раскрывается чёрная дыра: аккреционный диск, фотонное кольцо и чёрный
 * горизонт событий, который затягивает узел и схлопывается вместе с ним.
 *
 * Собрана из простой геометрии three.js — без шейдеров, canvas-текстур и внешних
 * ресурсов: слой визуализации прогоняется в Node (smoke-тесты), где ни `document`,
 * ни WebGL нет. Градиент колец сделан вершинными цветами: в аддитивном смешивании
 * чёрный цвет невидим, поэтому «кольцо, гаснущее наружу» получается само.
 */

import * as THREE from 'three';

/** Сегментов в кольцах: гладко, но дёшево. */
const RING_SEGMENTS = 96;
/** Скорость раскрытия и схлопывания (доля радиуса за секунду). */
const OPEN_RATE = 7;
const CLOSE_RATE = 3.2;
/** Сколько живёт вспышка после поглощения (с). */
const BURST_TIME = 0.5;
/** Доля радиуса, до которой оседает дыра, когда внутри ещё что-то есть. */
const IDLE_SCALE = 0.34;
/** До какого размера дыру можно растянуть двумя руками (множитель к обычному радиусу). */
export const HOLE_STRETCH_MAX = 3.2;
/** Сколько искр разлетается в момент поглощения. */
const SPARK_COUNT = 72;

interface DiskSpec {
  inner: number;
  outer: number;
  count: number;
  /** Угловая скорость вращения (рад/с). */
  speed: number;
  /** Наклон диска к плоскости кадра (рад). */
  tilt: number;
  size: number;
  innerColor: number;
  outerColor: number;
}

/** Три слоя аккреционного диска: горячий внутренний, пыльный средний, тусклый внешний. */
const DISKS: DiskSpec[] = [
  { inner: 1.12, outer: 1.9, count: 220, speed: 1.9, tilt: 0.4, size: 0.36, innerColor: 0xfff3dd, outerColor: 0xff8a3c },
  { inner: 1.8, outer: 3.1, count: 300, speed: 1.15, tilt: -0.26, size: 0.3, innerColor: 0xffb066, outerColor: 0x8b5cf6 },
  { inner: 2.9, outer: 4.6, count: 240, speed: 0.7, tilt: 0.14, size: 0.24, innerColor: 0x9a6bff, outerColor: 0x2a1a4d },
];

export class BlackHole {
  readonly object = new THREE.Group();

  /** Плоские кольца: всегда развёрнуты к камере, как настоящая линза. */
  #billboard = new THREE.Group();
  #core: THREE.Mesh;
  #photon: THREE.Mesh;
  #glow: THREE.Mesh;
  #rings: { holder: THREE.Group; points: THREE.Points }[] = [];
  #sparks: THREE.Points;
  #sparkDirections: Float32Array;

  #phase: 'closed' | 'opening' | 'idle' | 'closing' = 'closed';
  /** Полный радиус последнего раскрытия: к нему возвращаемся, когда дыру «берут в руку». */
  #base = 5;
  /** Текущий радиус (мировые единицы) и цель, к которой он стремится. */
  #radius = 0;
  #target = 0;
  #burst = 0;
  #hit = 0;
  /** Растяжение двумя руками: 1 — обычное, больше — дыра раздувается. */
  #stretch = 1;
  /** Дыра взорвана: гаснет быстро и ярко, искры бьют во все стороны. */
  #exploding = false;

  constructor() {
    this.#core = new THREE.Mesh(
      // Чуть меньше «единицы»: фотонное кольцо на радиусе 1.0 не тонет в силуэте горизонта.
      new THREE.SphereGeometry(0.92, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    this.#core.frustumCulled = false;
    this.object.add(this.#core);

    this.#photon = gradientRing(0.97, 1.18, new THREE.Color(1, 0.94, 0.82), 1);
    this.#glow = gradientRing(1, 2.75, new THREE.Color(0.55, 0.32, 1), 0.45);
    this.#billboard.add(this.#photon, this.#glow);
    this.object.add(this.#billboard);

    for (const spec of DISKS) {
      const holder = new THREE.Group();
      holder.rotation.x = spec.tilt;
      const points = makeDisk(spec);
      holder.add(points);
      this.object.add(holder);
      this.#rings.push({ holder, points });
    }

    this.#sparkDirections = new Float32Array(SPARK_COUNT * 3);
    this.#sparks = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3).fill(1e6), 3),
      ),
      new THREE.PointsMaterial({
        size: 0.5,
        color: 0xffd9a0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.#sparks.frustumCulled = false;
    this.object.add(this.#sparks);

    this.object.visible = false;
  }

  get alive(): boolean {
    return this.#phase !== 'closed';
  }

  /** Сейчас дыру держат (она раскрыта и готова отдать орбы). */
  get held(): boolean {
    return this.#phase === 'opening';
  }

  /** Текущий радиус горизонта событий — по нему граф решает, что узел уже проглочен. */
  get radius(): number {
    return this.#radius;
  }

  /** Текущее растяжение (1 — обычный размер). */
  get stretch(): number {
    return this.#stretch;
  }

  /**
   * Растянуть дыру (двумя руками). 1 — обычный размер, дальше она раздувается, диски
   * раскручиваются, а свечение уходит от фиолетового к раскалённому: видно, что «ещё
   * немного — и рванёт».
   */
  setStretch(factor: number): void {
    this.#stretch = Math.min(HOLE_STRETCH_MAX, Math.max(1, factor));
  }

  /** Взрыв: искры бьют во все стороны, дыра стремительно гаснет. */
  explode(): void {
    this.#burst = 1.2;
    this.#exploding = true;
    this.#phase = 'closing';
    this.#target = 0.001;
    for (let i = 0; i < SPARK_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.4 + Math.random() * 2.2;
      this.#sparkDirections[i * 3] = Math.cos(angle) * speed;
      this.#sparkDirections[i * 3 + 1] = (Math.random() - 0.5) * 1.6;
      this.#sparkDirections[i * 3 + 2] = Math.sin(angle) * speed;
    }
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  /** Раскрыть дыру в точке `at`. `radius` — размер горизонта событий в мировых единицах. */
  open(at: THREE.Vector3, radius = 5): void {
    this.object.position.copy(at);
    this.#stretch = 1;
    this.#exploding = false;
    this.#base = Math.max(0.5, radius);
    this.#target = this.#base;
    this.#phase = 'opening';
    this.#radius = Math.max(this.#radius, this.#target * 0.06);
    this.object.visible = true;
    this.#hit = 0;
  }

  /** Вспышка: узел ушёл за горизонт — кольца на миг разгораются. */
  pulse(strength = 1): void {
    this.#burst = Math.min(1.2, Math.max(this.#burst, strength));
    // Разбрасываем искры по плоскости диска — как будто вещество сорвалось с орбиты.
    for (let i = 0; i < SPARK_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.55 + Math.random() * 0.9;
      this.#sparkDirections[i * 3] = Math.cos(angle) * speed;
      this.#sparkDirections[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
      this.#sparkDirections[i * 3 + 2] = Math.sin(angle) * speed;
    }
  }

  /**
   * Осесть и остаться: после поглощения дыра не исчезает, а превращается в маленькую
   * «пылинку» — в неё можно засунуть руку и вытащить кого-нибудь обратно.
   */
  settle(): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'idle';
    this.#target = this.#base * IDLE_SCALE;
  }

  /** Взяли дыру в руку (`active`) — она раскрывается и светится; отпустили — снова оседает. */
  hold(active: boolean): void {
    if (this.#phase === 'closed') return;
    this.#phase = active ? 'opening' : 'idle';
    this.#target = (active ? this.#base * 1.15 : this.#base * IDLE_SCALE) * this.#stretch;
    if (active) this.#burst = Math.max(this.#burst, 0.5);
  }

  /** Пересчитать размер с учётом растяжения (вызывается каждый кадр из графа). */
  #applyStretch(): void {
    if (this.#phase === 'closed' || this.#phase === 'closing') return;
    this.#target = (this.#phase === 'opening' ? this.#base * 1.15 : this.#base * IDLE_SCALE) * this.#stretch;
  }

  /** Схлопнуться и погаснуть совсем (когда внутри ничего не осталось). */
  close(): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closing';
    this.#target = 0.001;
  }

  /** Кольца разворачиваем к камере — иначе плоские диски видны с ребра. */
  faceCamera(camera: THREE.Camera): void {
    this.#billboard.quaternion.copy(camera.quaternion);
  }

  update(dt: number, time: number): void {
    if (this.#phase === 'closed') return;
    this.#applyStretch();

    const idle = this.#phase === 'idle';
    const rate = this.#phase === 'closing' ? CLOSE_RATE : idle ? 2.2 : OPEN_RATE;
    if (this.#phase === 'closing') {
      this.#radius += (this.#target - this.#radius) * Math.min(1, dt * (this.#exploding ? rate * 2.2 : rate));
      if (this.#radius < 0.12) {
        this.#phase = 'closed';
        this.#radius = 0;
        this.object.visible = false;
        (this.#sparks.material as THREE.PointsMaterial).opacity = 0;
        return;
      }
    } else {
      // Лёгкое «дыхание» открытой дыры: она живая, а не нарисованная. Растянутая дыра
      // дышит чаще и сильнее — видно, что она едва держится.
      const wobble = 0.035 + (this.#stretch - 1) * 0.03;
      const speed = (idle ? 1.3 : 3.1) * (1 + (this.#stretch - 1) * 0.8);
      const breath = this.#target * (1 + Math.sin(time * speed) * wobble);
      this.#radius += (breath - this.#radius) * Math.min(1, dt * rate);
    }

    this.#burst = Math.max(0, this.#burst - dt / BURST_TIME);
    const flash = this.#burst * this.#burst;

    this.object.scale.setScalar(Math.max(0.001, this.#radius));
    const photon = this.#photon.material as THREE.MeshBasicMaterial;
    const glow = this.#glow.material as THREE.MeshBasicMaterial;
    // Осевшая дыра тускнеет: она ждёт, а не светит на всю сцену.
    const dim = idle ? 0.55 : 1;
    const heat = Math.max(0, this.#stretch - 1) / (HOLE_STRETCH_MAX - 1);
    photon.opacity = (0.75 + flash * 0.25) * dim;
    glow.opacity = Math.min(1, (0.4 + flash * 0.6 + heat * 0.5) * dim);
    // Раскалённое кольцо: ближе к срыву — ярче свечение, и цвет уходит в белый.
    this.#glow.scale.setScalar(1 + flash * 0.5 + heat * 0.6);
    this.#core.scale.setScalar(1 + flash * 0.25);
    if (heat > 0) photon.color.setRGB(1, 0.94 - heat * 0.35, 0.82 - heat * 0.65);

    for (let i = 0; i < this.#rings.length; i++) {
      const ring = this.#rings[i];
      const spec = DISKS[i];
      ring.points.rotation.y += dt * spec.speed * (1 + flash * 2.4) * (idle ? 0.5 : 1) * (1 + heat * 2.2);
      // Разгон при вспышке слегка «раскрывает» диски — видно, что дыра сработала.
      ring.holder.rotation.z = Math.sin(time * 0.6 + i) * 0.05 + flash * 0.08 + heat * 0.12;
      // Растянутая дыра раскачивает диски сильнее: она едва держится.
      ring.holder.rotation.x = DISKS[i].tilt + Math.sin(time * 1.7 + i * 2) * heat * 0.25;
    }

    // Искры живут только во время вспышки.
    const sparks = this.#sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const material = this.#sparks.material as THREE.PointsMaterial;
    if (this.#burst > 0) {
      const spread = this.#radius * (1 + (1 - this.#burst) * 3.4);
      for (let i = 0; i < SPARK_COUNT; i++) {
        sparks.setXYZ(
          i,
          this.#sparkDirections[i * 3] * spread,
          this.#sparkDirections[i * 3 + 1] * spread,
          this.#sparkDirections[i * 3 + 2] * spread,
        );
      }
      sparks.needsUpdate = true;
      material.opacity = Math.min(1, this.#burst * 1.6);
    } else if (material.opacity !== 0) {
      material.opacity = 0;
      for (let i = 0; i < SPARK_COUNT; i++) sparks.setXYZ(i, 1e6, 1e6, 1e6);
      sparks.needsUpdate = true;
    }
    void this.#hit;
  }

  dispose(): void {
    this.#core.geometry.dispose();
    (this.#core.material as THREE.Material).dispose();
    for (const mesh of [this.#photon, this.#glow]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const ring of this.#rings) {
      ring.points.geometry.dispose();
      (ring.points.material as THREE.Material).dispose();
    }
    this.#sparks.geometry.dispose();
    (this.#sparks.material as THREE.Material).dispose();
  }
}

/** Плоское кольцо, гаснущее к краю: `fade` — множитель прозрачности-цвета у внешней кромки. */
function gradientRing(inner: number, outer: number, color: THREE.Color, fade: number): THREE.Mesh {
  const geometry = new THREE.RingGeometry(inner, outer, RING_SEGMENTS, 1);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i));
    const edge = Math.min(1, Math.max(0, (radius - inner) / Math.max(1e-6, outer - inner)));
    const k = 1 - edge * (1 - fade);
    colors[i * 3] = color.r * k;
    colors[i * 3 + 1] = color.g * k;
    colors[i * 3 + 2] = color.b * k;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/** Кольцо частиц в плоскости XZ: вращается вокруг своей оси (аккреционный диск). */
function makeDisk(spec: DiskSpec): THREE.Points {
  const positions = new Float32Array(spec.count * 3);
  const colors = new Float32Array(spec.count * 3);
  const inner = new THREE.Color(spec.innerColor);
  const outer = new THREE.Color(spec.outerColor);
  const color = new THREE.Color();
  for (let i = 0; i < spec.count; i++) {
    const angle = Math.random() * Math.PI * 2;
    // Плотнее к центру: вещество в диске распределено неравномерно.
    const t = Math.pow(Math.random(), 0.65);
    const radius = spec.inner + (spec.outer - spec.inner) * t;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 0.09 * radius;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    color.copy(inner).lerp(outer, t);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: spec.size,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  points.frustumCulled = false;
  return points;
}
