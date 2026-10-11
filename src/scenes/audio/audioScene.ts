/**
 * Сцена 2 — аудиовизуализатор.
 *
 * Четыре режима на шейдерах (спектр, частицы, тоннель, деформируемая сфера) с общим
 * спектральным «каналом»: Rust считает FFT и присылает 64 полосы в дБ, фронтенд кладёт
 * их в 64-байтовую текстуру, из которой читают все шейдеры.
 *
 * Особенности:
 *  • режимы плавно перетекают друг в друга через вес (weight) — без рывков;
 *  • пауза (Space) или уход со сцены останавливает анализ звука на стороне Rust
 *    (`audio_set_active(false)`), CPU в фоне практически не тратится;
 *  • камера — орбитальная: мышь вращает, колесо зумит, без ввода включается авто-вращение.
 */

import * as THREE from 'three';

import { invoke } from '../../core/transport';
import { makeBandTexture, updateBandTexture, createGlowTexture, neonPalette } from '../../core/render/materials';
import { OrbitCamera } from '../../core/interaction/orbit';
import type { AudioModeId, SceneId } from '../../core/prefs';
import type { SceneContext, SceneModule, SceneState } from '../../core/scene';
import type { AudioInfo } from '../../core/types';
import {
  FLOOR_FRAGMENT,
  FLOOR_VERTEX,
  PARTICLES_FRAGMENT,
  PARTICLES_VERTEX,
  SPHERE_FRAGMENT,
  SPHERE_VERTEX,
  TUNNEL_FRAGMENT,
  TUNNEL_VERTEX,
} from './shaders';

const BANDS = 64;
/** Сколько частиц в режиме «частицы» (низкая цена для GPU, высокая — для картинки). */
const PARTICLE_COUNT = 120_000;

interface Visual {
  readonly object: THREE.Object3D;
  update(dt: number, time: number, state: SceneState): void;
  setWeight(weight: number): void;
  dispose(): void;
}

interface CameraPreset {
  distance: number;
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  autoRotate: number;
}

const MODES: { id: AudioModeId; label: string; key: string }[] = [
  { id: 'spectrum', label: 'Спектр', key: '1' },
  { id: 'particles', label: 'Частицы', key: '2' },
  { id: 'tunnel', label: 'Тоннель', key: '3' },
  { id: 'sphere', label: 'Сфера', key: '4' },
];

const CAMERA_PRESETS: Record<AudioModeId, CameraPreset> = {
  spectrum: {
    distance: 13.5,
    target: new THREE.Vector3(0, 1.6, -1.5),
    minDistance: 5,
    maxDistance: 26,
    autoRotate: 0.05,
  },
  particles: {
    distance: 15,
    target: new THREE.Vector3(0, 0, 0),
    minDistance: 3,
    maxDistance: 36,
    autoRotate: 0.09,
  },
  tunnel: {
    distance: 0.02,
    target: new THREE.Vector3(0, 0, 0),
    minDistance: 0.005,
    maxDistance: 0.6,
    autoRotate: 0.16,
  },
  sphere: {
    distance: 8.6,
    target: new THREE.Vector3(0, 0, 0),
    minDistance: 4,
    maxDistance: 22,
    autoRotate: 0.07,
  },
};

export class AudioScene implements SceneModule {
  readonly id: SceneId = 'audio';
  readonly title = 'Аудиовизуализатор';
  readonly subtitle = 'WASAPI loopback → FFT → GLSL';
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  #ctx: SceneContext;
  #orbit: OrbitCamera;
  #detachPointer: (() => void) | null = null;
  #visuals = new Map<AudioModeId, Visual>();
  #weights = new Map<AudioModeId, number>();
  #mode: AudioModeId = 'spectrum';
  #band = makeBandTexture(BANDS);
  #glow = createGlowTexture(96, 2.6);
  #activated = false;
  #unsubscribePrefs: (() => void) | null = null;
  #deviceLabel = 'нет данных';
  #panelDevice: HTMLElement | null = null;
  #cameraTween: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;

  constructor(ctx: SceneContext) {
    this.#ctx = ctx;

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.05, 400);
    this.#orbit = new OrbitCamera(this.camera, {
      distance: CAMERA_PRESETS.spectrum.distance,
      target: CAMERA_PRESETS.spectrum.target.clone(),
      minDistance: CAMERA_PRESETS.spectrum.minDistance,
      maxDistance: CAMERA_PRESETS.spectrum.maxDistance,
      autoRotate: CAMERA_PRESETS.spectrum.autoRotate,
      minPolar: 0.35,
      maxPolar: Math.PI - 0.2,
    });

    this.scene.add(this.#buildBackdrop());

    this.#visuals.set('spectrum', this.#buildSpectrum());
    this.#visuals.set('particles', this.#buildParticles());
    this.#visuals.set('tunnel', this.#buildTunnel());
    this.#visuals.set('sphere', this.#buildSphere());

    for (const [id, visual] of this.#visuals) {
      this.#weights.set(id, id === this.#mode ? 1 : 0);
      visual.setWeight(id === this.#mode ? 1 : 0);
      this.scene.add(visual.object);
    }
  }

  /* ─────────────────────────── Жизненный цикл сцены ─────────────────────────── */

  async activate(): Promise<void> {
    if (!this.#activated) {
      const canvas = document.getElementById('viewport');
      if (canvas) this.#detachPointer = this.#orbit.attach(canvas);
      this.#mode = this.#ctx.prefs.get().audioMode;
      this.#applyMode(this.#mode, true);

      this.#unsubscribePrefs = this.#ctx.prefs.subscribe((prefs, changed) => {
        if (changed.includes('audioMode')) this.#applyMode(prefs.audioMode, false);
        if (changed.includes('audioSource')) void this.#applySource(prefs.audioSource);
      });
      this.#activated = true;
    }

    await this.#applySource(this.#ctx.prefs.get().audioSource);
  }

  deactivate(): void {
    // Захват звука не нужен, пока сцена не на экране: останавливаем FFT на стороне Rust.
    void invoke('audio_set_active', { active: false }).catch(() => undefined);
  }

  /** Синхронизировать HUD и запустить/остановить источник. */
  async #applySource(source: 'system' | 'mic' | 'none'): Promise<void> {
    if (source === 'system') {
      void invoke('audio_set_active', { active: true }).catch(() => undefined);
      try {
        const info = await invoke<AudioInfo>('audio_start');
        if (info?.available) {
          this.#setDevice(`${info.device ?? 'системный звук'} · ${(info.sampleRate ?? 0) / 1000} кГц`);
          this.#ctx.audio.useSilence(); // системный поток придёт событием и переключит источник сам
        } else if (info?.reason) {
          this.#ctx.toast('warn', `Захват звука недоступен: ${info.reason}. Включите микрофон в настройках.`);
          this.#setDevice('нет системного звука');
        }
      } catch (err) {
        this.#setDevice('недоступно');
        this.#ctx.toast('warn', `WASAPI loopback недоступен (${String(err)}). Можно переключиться на микрофон.`);
      }
    } else if (source === 'mic') {
      try {
        await this.#ctx.audio.useMic();
        this.#setDevice(`микрофон · ${(this.#ctx.audio.info.sampleRate ?? 0) / 1000} кГц`);
      } catch (err) {
        this.#ctx.toast('error', `Микрофон недоступен: ${String(err)}`);
      }
    } else {
      this.#ctx.audio.useSilence();
      this.#setDevice('тишина');
    }
  }

  #setDevice(label: string): void {
    this.#deviceLabel = label;
    if (this.#panelDevice) this.#panelDevice.textContent = label;
  }

  modeLabel(): string {
    return MODES.find((mode) => mode.id === this.#mode)?.label ?? '—';
  }

  #applyMode(mode: AudioModeId, immediate: boolean): void {
    if (!this.#visuals.has(mode)) return;
    this.#mode = mode;
    for (const [id, weight] of this.#weights) {
      this.#weights.set(id, immediate ? (id === mode ? 1 : 0) : weight);
    }
    if (immediate) {
      for (const [id, visual] of this.#visuals) visual.setWeight(id === mode ? 1 : 0);
    }

    const preset = CAMERA_PRESETS[mode];
    this.#orbit.setDistance(preset.distance);
    this.#orbit.setAutoRotate(preset.autoRotate);
    this.#cameraTween = {
      from: this.#orbit.target.clone(),
      to: preset.target.clone(),
      t: immediate ? 1 : 0,
    };
    if (immediate) this.#orbit.target.copy(preset.target);

    this.#ctx.hud.setActiveMode(mode);
  }

  update(dt: number, time: number, state: SceneState): void {
    const audio = this.#ctx.audio.snapshot;

    // 64 байта спектра → текстура, которую читают все шейдеры.
    updateBandTexture(this.#band.texture, this.#band.data, audio.bands);

    // Переключение режимов: веса плавно перетекают друг в друга.
    for (const [id, visual] of this.#visuals) {
      const target = id === this.#mode ? 1 : 0;
      const current = this.#weights.get(id) ?? 0;
      const next = immediateLerp(current, target, dt, 0.45);
      if (next !== current) this.#weights.set(id, next);
      visual.setWeight(next);
      if (next > 0.002) visual.update(dt, time, state);
    }

    // Плавная доводка точки интереса камеры при смене режима.
    if (this.#cameraTween && this.#cameraTween.t < 1) {
      this.#cameraTween.t = Math.min(1, this.#cameraTween.t + dt / 0.6);
      const eased = easeInOut(this.#cameraTween.t);
      this.#orbit.target.lerpVectors(this.#cameraTween.from, this.#cameraTween.to, eased);
    }

    if (this.#backdropMaterial) {
      this.#backdropMaterial.uniforms.uTime.value = time;
      this.#backdropMaterial.uniforms.uEnergy.value = audio.energy;
    }

    this.#orbit.update(dt);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  onKey(code: string): boolean {
    if (code !== 'KeyM') return false;
    const index = MODES.findIndex((mode) => mode.id === this.#mode);
    const next = MODES[(index + 1) % MODES.length];
    this.#ctx.prefs.set({ audioMode: next.id });
    return true;
  }

  hudPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'hud-panel';
    const inner = document.createElement('div');
    inner.className = 'hud-panel-inner';
    panel.appendChild(inner);

    const title = document.createElement('div');
    title.className = 'hud-panel-title';
    title.innerHTML = `<strong>Режим визуализации</strong><span class="hud-label">M — следующий</span>`;
    inner.appendChild(title);

    inner.appendChild(
      this.#ctx.hud.buildModeSwitch(MODES, (id) => {
        this.#ctx.prefs.set({ audioMode: id });
      }),
    );

    const info = document.createElement('div');
    info.className = 'hud-field';
    info.style.marginTop = '12px';
    const head = document.createElement('div');
    head.className = 'hud-field-head';
    head.innerHTML = '<span class="hud-label">Источник звука</span>';
    const device = document.createElement('span');
    device.className = 'hud-field-value';
    device.textContent = this.#deviceLabel;
    head.appendChild(device);
    info.appendChild(head);
    inner.appendChild(info);
    this.#panelDevice = device;

    const hint = document.createElement('div');
    hint.className = 'hud-label';
    hint.style.marginTop = '10px';
    hint.textContent = 'ЛКМ — вращение · колесо — зум · Space — пауза';
    inner.appendChild(hint);

    // Панель активна только пока сцена на экране: ядро создаёт её при активации.
    this.#ctx.hud.setActiveMode(this.#mode);
    return panel;
  }

  dispose(): void {
    this.#detachPointer?.();
    this.#unsubscribePrefs?.();
    for (const visual of this.#visuals.values()) visual.dispose();
    this.#visuals.clear();
    this.#band.texture.dispose();
    this.#glow.dispose();
  }

  /* ─────────────────────────── Режимы ─────────────────────────── */

  #buildBackdrop(): THREE.Object3D {
    // Тёмная «сфера-космос» даёт глубину за счёт авроральных полос и убирает плоский фон.
    const geometry = new THREE.SphereGeometry(180, 32, 24);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0 },
        uMix: { value: 1 },
        uBand: { value: this.#band.texture },
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
        uniform float uMix;
        uniform sampler2D uBand;
        varying vec3 vDir;

        vec3 heat(float t) {
          t = clamp(t, 0.0, 1.0);
          return t < 0.5
            ? mix(vec3(0.05, 0.12, 0.25), vec3(0.28, 0.22, 0.55), t * 2.0)
            : mix(vec3(0.28, 0.22, 0.55), vec3(0.45, 0.18, 0.35), (t - 0.5) * 2.0);
        }

        void main() {
          float azimuth = atan(vDir.z, vDir.x) / 6.2831 + 0.5;
          float band = texture2D(uBand, vec2(azimuth, 0.5)).r;

          // Медленные авроральные волны у «горизонта».
          float horizon = smoothstep(-0.1, 0.85, vDir.y);
          float wave = sin(azimuth * 24.0 + uTime * 0.25) * 0.5 + 0.5;
          vec3 color = heat(band * 0.7 + wave * 0.3) * (0.10 + band * 0.35 + uEnergy * 0.25) * horizon;
          color += vec3(0.02, 0.035, 0.07) * (1.0 - vDir.y) * 0.6;

          gl_FragColor = vec4(color * uMix, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -900;
    this.#backdropMaterial = material;
    return mesh;
  }

  #backdropMaterial: THREE.ShaderMaterial | null = null;

  /** Режим 1: колонны спектра по дуге + зеркальный пол + корона пульсаций. */
  #buildSpectrum(): Visual {
    const group = new THREE.Group();
    const bars = new THREE.InstancedMesh(
      withBottomOrigin(new THREE.BoxGeometry(0.17, 1, 0.24)),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      BANDS,
    );
    bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bars.frustumCulled = false;

    const crownCount = BANDS;
    const crown = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.075, 10, 8),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      crownCount,
    );
    crown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    crown.frustumCulled = false;

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(22, 96),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uBand: { value: this.#band.texture },
          uTime: { value: 0 },
          uEnergy: { value: 0 },
          uOpacity: { value: 1 },
        },
        vertexShader: FLOOR_VERTEX,
        fragmentShader: FLOOR_FRAGMENT,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.001;

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.6, 2),
      new THREE.MeshBasicMaterial({ color: 0x9fe8ff, toneMapped: false }),
    );
    core.position.set(0, 2.2, -4.5);

    group.add(bars, crown, floor, core);

    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const ARC = 1.15; // полурадианная ширина дуги
    const RADIUS = 9.4;

    // Базовое положение колонн задаётся один раз — дальше меняем только масштаб и цвет.
    const positions: { x: number; z: number; angle: number }[] = [];
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1);
      const angle = -ARC / 2 + t * ARC;
      const x = Math.sin(angle) * RADIUS;
      const z = Math.cos(angle) * RADIUS - RADIUS * 0.86;
      positions.push({ x, z, angle });
      color.copy(neonPalette(t * 0.9)).convertSRGBToLinear();
      bars.setColorAt(i, color);
    }
    bars.instanceColor!.needsUpdate = true;

    return {
      object: group,
      update: (dt, time) => {
        const audio = this.#ctx.audio.snapshot;
        const energy = audio.energy;
        for (let i = 0; i < BANDS; i++) {
          const value = audio.bands[i];
          const height = 0.35 + Math.pow(value, 1.35) * 7.2 + audio.beat * 0.5;
          const { x, z, angle } = positions[i];
          matrix.makeRotationY(angle);
          matrix.scale(new THREE.Vector3(1, height, 1));
          matrix.setPosition(x, 0, z);
          bars.setMatrixAt(i, matrix);

          // Корона: маленькие сферы над колоннами, дрожат на высоких частотах.
          const wobble = Math.sin(time * 3.2 + i * 0.7) * 0.12;
          matrix.makeScale(1, 1, 1);
          matrix.setPosition(
            x * 0.55,
            1.6 + value * 3.4 + wobble + audio.bass * 0.8,
            z * 0.55,
          );
          crown.setMatrixAt(i, matrix);
        }
        bars.instanceMatrix.needsUpdate = true;
        crown.instanceMatrix.needsUpdate = true;

        const floorMaterial = floor.material as THREE.ShaderMaterial;
        floorMaterial.uniforms.uTime.value = time;
        floorMaterial.uniforms.uEnergy.value = energy;

        const coreScale = 1 + audio.bass * 2.4 + audio.beat * 1.2;
        core.scale.setScalar(coreScale);
        core.rotation.y += dt * 0.6;
      },
      setWeight: (weight) => {
        group.visible = weight > 0.02;
        (floor.material as THREE.ShaderMaterial).uniforms.uOpacity.value = weight;
        (bars.material as THREE.MeshBasicMaterial).opacity = weight;
        (crown.material as THREE.MeshBasicMaterial).opacity = weight;
        (core.material as THREE.MeshBasicMaterial).opacity = weight;
        (bars.material as THREE.MeshBasicMaterial).transparent = weight < 0.999;
        (crown.material as THREE.MeshBasicMaterial).transparent = weight < 0.999;
        (core.material as THREE.MeshBasicMaterial).transparent = weight < 0.999;
      },
      dispose: () => {
        bars.geometry.dispose();
        (bars.material as THREE.Material).dispose();
        crown.geometry.dispose();
        (crown.material as THREE.Material).dispose();
        floor.geometry.dispose();
        (floor.material as THREE.Material).dispose();
        core.geometry.dispose();
        (core.material as THREE.Material).dispose();
      },
    };
  }

  /** Режим 2: 120 000 частиц, анимируемых полностью на GPU. */
  #buildParticles(): Visual {
    const geometry = new THREE.BufferGeometry();
    const dir = new Float32Array(PARTICLE_COUNT * 3);
    const seed = new Float32Array(PARTICLE_COUNT * 4);
    const position = new Float32Array(PARTICLE_COUNT * 3); // статичный «нуль», всё считает шейдер

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Равномерное распределение по сфере (не «полюса»): нормальный вектор.
      let x = 0;
      let y = 0;
      let z = 0;
      let length = 0;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        length = Math.hypot(x, y, z);
      } while (length < 0.15 || length > 1);
      dir[i * 3] = x / length;
      dir[i * 3 + 1] = y / length;
      dir[i * 3 + 2] = z / length;

      seed[i * 4] = Math.random();
      seed[i * 4 + 1] = 0.45 + Math.random() * 2.4;
      seed[i * 4 + 2] = Math.random();
      // Индекс полосы привязан к «широте» частицы: низ = бас, верх = высокие.
      seed[i * 4 + 3] = Math.min(0.999, Math.max(0, dir[i * 3 + 1] * 0.5 + 0.5));
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uBand: { value: this.#band.texture },
        uTime: { value: 0 },
        uBass: { value: 0 },
        uEnergy: { value: 0 },
        uBeat: { value: 0 },
        uSize: { value: 3.4 },
        uPixelRatio: { value: 1.5 },
        uSpread: { value: 4.6 },
        uOpacity: { value: 1 },
      },
      vertexShader: PARTICLES_VERTEX,
      fragmentShader: PARTICLES_FRAGMENT,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.#glow,
        color: 0x7fe6ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.scale.setScalar(6);

    const group = new THREE.Group();
    group.add(points, sprite);

    return {
      object: group,
      update: (_dt, time) => {
        const audio = this.#ctx.audio.snapshot;
        material.uniforms.uTime.value = time;
        material.uniforms.uBass.value = audio.bass;
        material.uniforms.uEnergy.value = audio.energy;
        material.uniforms.uBeat.value = audio.beat;
        material.uniforms.uSpread.value = 3.6 + audio.energy * 2.6 + audio.beat * 1.4;

        const pulse = 1 + audio.bass * 0.5 + audio.beat * 0.35;
        sprite.scale.setScalar(5.5 * pulse);
      },
      setWeight: (weight) => {
        group.visible = weight > 0.02;
        material.uniforms.uOpacity.value = weight;
        material.opacity = weight; // сцены не читают opacity напрямую, но так безопаснее
        (sprite.material as THREE.SpriteMaterial).opacity = weight * 0.9;
        material.transparent = true;
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
        sprite.material.dispose();
      },
    };
  }

  /** Режим 3: полёт по тоннелю, стенки которого дышат спектром. */
  #buildTunnel(): Visual {
    const geometry = new THREE.CylinderGeometry(6, 6, 110, 160, 1, true);
    geometry.rotateX(Math.PI / 2); // ось цилиндра → Z (камера летит вдоль неё)

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uBand: { value: this.#band.texture },
        uTime: { value: 0 },
        uEnergy: { value: 0 },
        uBeat: { value: 0 },
        uRadius: { value: 1 },
        uOpacity: { value: 1 },
      },
      vertexShader: TUNNEL_VERTEX,
      fragmentShader: TUNNEL_FRAGMENT,
    });

    const tunnel = new THREE.Mesh(geometry, material);
    tunnel.frustumCulled = false;

    // Дальняя «звёздная пыль» в конце тоннеля — точка притяжения взгляда.
    const starGeometry = new THREE.BufferGeometry();
    const starCount = 900;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 5;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius;
      positions[i * 3 + 2] = -20 - Math.random() * 80;
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        size: 0.16,
        color: 0xbfe9ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );

    const group = new THREE.Group();
    group.add(tunnel, stars);

    return {
      object: group,
      update: (dt, time) => {
        const audio = this.#ctx.audio.snapshot;
        material.uniforms.uTime.value = time;
        material.uniforms.uEnergy.value = audio.energy;
        material.uniforms.uBeat.value = audio.beat;
        material.uniforms.uRadius.value = 1 + audio.bass * 0.25;
        stars.rotation.z += dt * 0.05;
        // Камера «летит»: сдвигаем пыль вдоль тоннеля и зацикливаем.
        stars.position.z = (stars.position.z + dt * (6 + audio.energy * 20)) % 100;
      },
      setWeight: (weight) => {
        group.visible = weight > 0.02;
        material.uniforms.uOpacity.value = weight;
        (stars.material as THREE.PointsMaterial).opacity = weight * 0.8;
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
        starGeometry.dispose();
        (stars.material as THREE.Material).dispose();
      },
    };
  }

  /** Режим 4: деформируемая сфера на шуме + каркас + ядро. */
  #buildSphere(): Visual {
    const geometry = new THREE.IcosahedronGeometry(2.4, 48);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uBand: { value: this.#band.texture },
        uTime: { value: 0 },
        uBass: { value: 0 },
        uEnergy: { value: 0 },
        uBeat: { value: 0 },
        uDisplace: { value: 1 },
        uOpacity: { value: 1 },
      },
      vertexShader: SPHERE_VERTEX,
      fragmentShader: SPHERE_FRAGMENT,
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.frustumCulled = false;

    const wireGeometry = new THREE.IcosahedronGeometry(2.55, 6);
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x7fe6ff,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const wire = new THREE.Mesh(wireGeometry, wireMaterial);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xdff6ff }),
    );

    const group = new THREE.Group();
    group.add(sphere, wire, core);

    return {
      object: group,
      update: (dt, time) => {
        const audio = this.#ctx.audio.snapshot;
        material.uniforms.uTime.value = time;
        material.uniforms.uBass.value = audio.bass;
        material.uniforms.uEnergy.value = audio.energy;
        material.uniforms.uBeat.value = audio.beat;
        material.uniforms.uDisplace.value = 0.55 + audio.energy * 0.9;

        wire.rotation.y -= dt * 0.18;
        wire.rotation.x += dt * 0.07;
        const wireScale = 1 + audio.beat * 0.08;
        wire.scale.setScalar(wireScale);

        core.scale.setScalar(0.85 + audio.bass * 1.1 + audio.beat * 0.5);
      },
      setWeight: (weight) => {
        group.visible = weight > 0.02;
        material.uniforms.uOpacity.value = weight;
        wireMaterial.opacity = weight * 0.12;
        (core.material as THREE.MeshBasicMaterial).opacity = weight;
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
        wireGeometry.dispose();
        wireMaterial.dispose();
        core.geometry.dispose();
        (core.material as THREE.Material).dispose();
      },
    };
  }
}

/* ─────────────────────────── Хелперы ─────────────────────────── */

/** Сместить геометрию так, чтобы точка роста была в основании (удобно для колонн). */
function withBottomOrigin(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.translate(0, 0.5, 0);
  return geometry;
}

function immediateLerp(current: number, target: number, dt: number, duration: number): number {
  if (current === target) return current;
  const step = dt / duration;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
