/**
 * Рендер-ядро: один WebGL-контекст, одна цепочка пост-обработки и независимые модули сцен.
 *
 * Задачи ядра:
 *  • единый пайплайн Render → Bloom → Grade → Output (HDR-таргеты, ACES, sRGB на выходе);
 *  • плавный «пролёт» между сценами (уходящая сцена рендерится в отдельный таргет и
 *    подмешивается в финальном шейдере вместе с радиальным варпом и вспышкой);
 *  • экономия ресурсов: пауза, кадры «по требованию», адаптивное разрешение, стоп в фоне.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { GradePass } from './grade';
import type { AudioBus } from '../audio/bus';
import type { PrefsStore, SceneId } from '../prefs';
import type { SceneModule, SceneState } from '../scene';

export interface EngineStats {
  fps: number;
  workMs: number;
  frameMs: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  width: number;
  height: number;
}

const TRANSITION_SECONDS = 1.15;
/** Ступени масштаба рендера: 1.5 — «жирный» апскейл, 0.6 — тяжёлый сценарий. */
const QUALITY_STEPS = [1.5, 1.32, 1.15, 1.0, 0.86, 0.74, 0.62];
const TARGET_WORK_MS = 12.5;
const HEAVY_WORK_MS = 19.0;

export class Engine {
  readonly stats: EngineStats = {
    fps: 0,
    workMs: 0,
    frameMs: 0,
    pixelRatio: 1,
    drawCalls: 0,
    triangles: 0,
    width: 1,
    height: 1,
  };

  #canvas: HTMLCanvasElement;
  #renderer: THREE.WebGLRenderer;
  #composer: EffectComposer;
  #renderPass: RenderPass;
  #bloom: UnrealBloomPass;
  #grade: GradePass;
  #prevTarget: THREE.WebGLRenderTarget;

  #prefs: PrefsStore;
  #audio: AudioBus;

  #modules = new Map<SceneId, SceneModule>();
  #order: SceneId[] = [];
  #currentId: SceneId | null = null;
  #transition: { from: SceneId; to: SceneId; elapsed: number; dir: number } | null = null;

  #width = 1;
  #height = 1;
  #qualityIndex = 3;
  #qualityTimer = 0;
  #qualityUpTimer = 0;

  #running = false;
  #dirty = true;
  #frameHandle = 0;
  #timerHandle = 0;
  #lastNow = 0;
  #lastRender = 0;
  #fpsWindow = 0;
  #fpsFrames = 0;
  #time = 0;

  onSceneChange: ((id: SceneId) => void) | null = null;

  #frameHooks: ((dt: number, time: number) => void)[] = [];

  constructor(canvas: HTMLCanvasElement, prefs: PrefsStore, audio: AudioBus) {
    this.#canvas = canvas;
    this.#prefs = prefs;
    this.#audio = audio;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // сглаживание даёт MSAA внутри composer-таргетов
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x04060c, 1);
    renderer.toneMapping = THREE.NoToneMapping; // ACES делает GradePass
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = false;
    this.#renderer = renderer;

    const pixelRatio = this.#resolvePixelRatio();
    renderer.setPixelRatio(pixelRatio);
    this.stats.pixelRatio = pixelRatio;

    // MSAA внутри HDR-таргета: сглаживание работает и для пост-обработки
    // (WebGL2 multisampled render target, three сам делает resolve при чтении).
    const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const composerTarget = new THREE.WebGLRenderTarget(
      Math.max(1, drawingSize.x),
      Math.max(1, drawingSize.y),
      { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false },
    );
    this.#composer = new EffectComposer(renderer, composerTarget);
    this.#composer.setPixelRatio(pixelRatio);

    this.#renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.#composer.addPass(this.#renderPass);

    this.#bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      prefs.get().bloomStrength,
      prefs.get().bloomRadius,
      prefs.get().bloomThreshold,
    );
    this.#composer.addPass(this.#bloom);

    this.#grade = new GradePass();
    this.#composer.addPass(this.#grade);

    this.#composer.addPass(new OutputPass());

    this.#prevTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.#applyPrefs();
    this.#measure();
  }

  /* ─────────────────────────── Управление сценами ─────────────────────────── */

  register(module: SceneModule): void {
    this.#modules.set(module.id, module);
    if (!this.#order.includes(module.id)) this.#order.push(module.id);
    module.resize(this.#width, this.#height, this.stats.pixelRatio);
    if (!this.#currentId) {
      this.#currentId = module.id;
      this.#renderPass.scene = module.scene;
      this.#renderPass.camera = module.camera;
      void module.activate?.();
      this.onSceneChange?.(module.id);
    }
  }

  get currentId(): SceneId | null {
    return this.#currentId;
  }

  get currentModule(): SceneModule | null {
    return this.#currentId ? this.#modules.get(this.#currentId) ?? null : null;
  }

  /** Перейти к сцене с «пролётом». Направление задаётся порядком вкладок (влево/вправо). */
  setScene(id: SceneId): void {
    if (id === this.#currentId) return;
    const target = this.#modules.get(id);
    if (!target) return;

    const fromIndex = this.#currentId ? this.#order.indexOf(this.#currentId) : 0;
    const dir = this.#order.indexOf(id) >= fromIndex ? 1 : -1;

    if (!this.#currentId) {
      this.#currentId = id;
      this.#renderPass.scene = target.scene;
      this.#renderPass.camera = target.camera;
      void target.activate?.();
      this.onSceneChange?.(id);
      this.#dirty = true;
      return;
    }

    const previous = this.#modules.get(this.#currentId);
    previous?.deactivate?.();
    this.#transition = { from: this.#currentId, to: id, elapsed: 0, dir };
    this.#currentId = id;
    this.#renderPass.scene = target.scene;
    this.#renderPass.camera = target.camera;
    void target.activate?.();
    this.onSceneChange?.(id);
    this.#dirty = true;
  }

  /* ─────────────────────────── Жизненный цикл ─────────────────────────── */

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#dirty = true;
    this.#lastNow = performance.now();
    this.#schedule();
    document.addEventListener('visibilitychange', this.#onVisibility);
    window.addEventListener('resize', this.#onResize);
  }

  /**
   * Хук, вызываемый в начале каждого отрисованного кадра, до обновления сцен.
   * Через него подключается слой жестов: сцены должны видеть уже актуальный курсор.
   */
  addFrameHook(hook: (dt: number, time: number) => void): () => void {
    this.#frameHooks.push(hook);
    return () => {
      const index = this.#frameHooks.indexOf(hook);
      if (index >= 0) this.#frameHooks.splice(index, 1);
    };
  }

  /** Перерисовать кадр (после смены настроек, размера и т.п.). */
  invalidate(): void {
    this.#dirty = true;
    if (this.#running) this.#schedule();
  }

  dispose(): void {
    this.#running = false;
    cancelAnimationFrame(this.#frameHandle);
    clearTimeout(this.#timerHandle);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('resize', this.#onResize);
    for (const module of this.#modules.values()) module.dispose();
    this.#modules.clear();
    this.#grade.dispose();
    this.#bloom.dispose();
    this.#composer.dispose();
    this.#prevTarget.dispose();
    this.#renderer.dispose();
  }

  #schedule(): void {
    if (!this.#running) return;
    cancelAnimationFrame(this.#frameHandle);
    clearTimeout(this.#timerHandle);
    if (this.#isIdle()) {
      // Пауза: кадры «по требованию» — CPU почти не тратится.
      this.#timerHandle = window.setTimeout(() => this.#frame(), 200);
    } else {
      this.#frameHandle = requestAnimationFrame(() => this.#frame());
    }
  }

  #isIdle(): boolean {
    return this.#prefs.get().paused || document.hidden;
  }

  #onVisibility = (): void => {
    if (this.#prefs.get().pauseWhenHidden) {
      this.#dirty = true;
      this.#lastNow = performance.now();
    }
  };

  #onResize = (): void => {
    this.#measure();
    this.#dirty = true;
  };

  /* ─────────────────────────── Кадр ─────────────────────────── */

  #frame(): void {
    if (!this.#running) return;
    const now = performance.now();

    // Ограничитель частоты кадров: лишние vsync-сигналы пропускаем, не тратя CPU.
    const cap = this.#prefs.get().fpsCap;
    if (cap !== 'unlimited' && now - this.#lastRender < 1000 / Number(cap) - 2) {
      this.#frameHandle = requestAnimationFrame(() => this.#frame());
      return;
    }
    this.#lastRender = now;

    const frameMs = Math.min(100, now - this.#lastNow);
    this.#lastNow = now;

    const idle = this.#isIdle();

    if (!idle || this.#dirty) {
      const workStart = performance.now();
      const dt = Math.min(0.05, frameMs / 1000);
      this.#time += dt;

      this.#audio.update(dt);
      for (const hook of this.#frameHooks) hook(dt, this.#time);
      this.#updateTransition(dt);
      this.#updateScenes(dt, idle);

      this.#applyPrefs();
      this.#renderFrame(dt);

      // Адаптивное разрешение: ориентируемся на время «полезной» работы, а не на FPS
      // (ограничитель кадров иначе маскировал бы перегрузку).
      const workMs = performance.now() - workStart;
      this.stats.workMs = this.stats.workMs * 0.9 + workMs * 0.1;
      this.#adaptQuality(dt);
      this.#dirty = false;
    }

    // Статистика
    this.stats.frameMs = this.stats.frameMs * 0.9 + frameMs * 0.1;
    this.#fpsWindow += frameMs;
    this.#fpsFrames += 1;
    if (this.#fpsWindow >= 500) {
      this.stats.fps = (this.#fpsFrames * 1000) / this.#fpsWindow;
      this.#fpsWindow = 0;
      this.#fpsFrames = 0;
    }

    this.#schedule();
  }

  #updateTransition(dt: number): void {
    if (!this.#transition) return;
    this.#transition.elapsed += dt;
    if (this.#transition.elapsed >= TRANSITION_SECONDS) this.#transition = null;
  }

  #sceneState(id: SceneId, paused: boolean): SceneState {
    const transition = this.#transition;
    if (!transition) {
      return { active: id === this.#currentId, enter: 1, dir: 1, outgoing: false, paused };
    }
    const raw = Math.min(1, transition.elapsed / TRANSITION_SECONDS);
    const easing = raw * raw * (3 - 2 * raw); // smoothstep
    const outgoing = transition.from === id;
    return {
      active: false,
      enter: outgoing ? 1 - easing : easing,
      dir: transition.dir,
      outgoing,
      paused,
    };
  }

  #updateScenes(dt: number, paused: boolean): void {
    // На паузе визуализация заморожена: не тратим CPU на пересчёт физики и анимаций.
    if (paused) return;
    for (const [id, module] of this.#modules) {
      if (this.#currentId !== id && this.#transition?.from !== id) continue;
      module.update(dt, this.#time, this.#sceneState(id, false));
    }
  }

  #renderFrame(dt: number): void {
    const renderer = this.#renderer;
    const composer = this.#composer;
    const transition = this.#transition;

    renderer.info.reset();

    if (transition) {
      const outgoing = this.#modules.get(transition.from);
      if (outgoing) {
        // Первый кадр перехода фиксирует «откуда летим» — рисуем уходящую сцену в таргет.
        renderer.setRenderTarget(this.#prevTarget);
        renderer.clear();
        renderer.render(outgoing.scene, outgoing.camera);
        renderer.setRenderTarget(null);
        this.#grade.material.uniforms.uPrev.value = this.#prevTarget.texture;
      }
      const raw = Math.min(1, transition.elapsed / TRANSITION_SECONDS);
      this.#grade.material.uniforms.uMix.value = raw * raw * (3 - 2 * raw);
      this.#grade.material.uniforms.uWarp.value = Math.sin(raw * Math.PI) * 0.85;
      this.#grade.material.uniforms.uFlash.value = Math.sin(raw * Math.PI) * 0.16;
    } else {
      this.#grade.material.uniforms.uMix.value = 0;
      this.#grade.material.uniforms.uWarp.value = 0;
      this.#grade.material.uniforms.uFlash.value = 0;
    }

    const current = this.currentModule;
    if (current) {
      this.#renderPass.scene = current.scene;
      this.#renderPass.camera = current.camera;
    }

    this.#grade.material.uniforms.uTime.value = this.#time;
    composer.render(dt);

    this.stats.drawCalls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
  }

  #applyPrefs(): void {
    const prefs = this.#prefs.get();
    const energy = this.#audio.snapshot.energy;
    const beat = this.#audio.snapshot.beat;

    if (prefs.bloomEnabled) {
      // Цветокоррекция реагирует на звук: сцена «дышит» вместе с музыкой.
      this.#bloom.strength = prefs.bloomStrength + energy * 0.35 + beat * 0.2;
      this.#bloom.radius = prefs.bloomRadius + beat * 0.05;
      this.#bloom.threshold = prefs.bloomThreshold;
      this.#bloom.enabled = true;
    } else {
      this.#bloom.enabled = false;
    }

    const uniforms = this.#grade.material.uniforms;
    uniforms.uExposure.value = prefs.exposure + energy * 0.06;
    uniforms.uContrast.value = prefs.contrast;
    uniforms.uSaturation.value = prefs.saturation + energy * 0.05;
    uniforms.uChroma.value = prefs.chroma;
    uniforms.uVignette.value = prefs.vignette;
    uniforms.uGrain.value = prefs.grain;
  }

  #adaptQuality(dt: number): void {
    const prefs = this.#prefs.get();
    if (!prefs.adaptiveQuality) {
      if (this.#qualityIndex !== 3) {
        this.#qualityIndex = 3;
        this.#measure();
      }
      return;
    }

    this.#qualityTimer += dt;
    this.#qualityUpTimer += dt;

    if (this.stats.workMs > HEAVY_WORK_MS && this.#qualityTimer > 1.0) {
      this.#qualityTimer = 0;
      this.#qualityUpTimer = 0;
      if (this.#qualityIndex < QUALITY_STEPS.length - 1) {
        this.#qualityIndex += 1;
        this.#measure();
      }
    } else if (this.stats.workMs < TARGET_WORK_MS && this.#qualityUpTimer > 3.0) {
      this.#qualityUpTimer = 0;
      if (this.#qualityIndex > 0) {
        this.#qualityIndex -= 1;
        this.#measure();
      }
    }
  }

  #resolvePixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    // Верхний предел 1.75: выше на Windows и 4K заметного выигрыша нет,
    // а нагрузка на GPU растёт квадратично.
    return Math.min(dpr, 1.75);
  }

  /** Полный пересчёт размеров: resize окна, смена качества, старт. */
  #measure(): void {
    const width = Math.max(1, this.#canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.#canvas.clientHeight || window.innerHeight);
    this.#width = width;
    this.#height = height;
    this.stats.width = width;
    this.stats.height = height;

    const ratio = this.#resolvePixelRatio() * QUALITY_STEPS[this.#qualityIndex];
    this.stats.pixelRatio = ratio;

    this.#renderer.setPixelRatio(ratio);
    this.#renderer.setSize(width, height, false);
    this.#composer.setPixelRatio(ratio);
    this.#composer.setSize(width, height); // пассы получат размер с учётом pixelRatio
    this.#prevTarget.setSize(
      Math.max(1, Math.round(width * ratio)),
      Math.max(1, Math.round(height * ratio)),
    );

    for (const module of this.#modules.values()) module.resize(width, height, ratio);
    this.#dirty = true;
  }
}
