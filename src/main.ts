/**
 * Точка входа VORTEX.
 *
 * Приложение собирается как `App`, который:
 *  • создаёт рендер-ядро, HUD, аудиошину и слой жестов;
 *  • регистрирует независимые модули сцен;
 *  • связывает настройки, горячие клавиши и события бэкенда;
 *  • умеет работать в режиме «окно вывода» — без HUD, для второго монитора.
 */

import './style.css';

import { invoke, isTauri, listen } from './core/transport';
import { PrefsStore, type AudioModeId, type SceneId } from './core/prefs';
import { AudioBus } from './core/audio/bus';
import { Engine } from './core/render/engine';
import { Hud, type AppHost } from './core/hud/hud';
import { PointerHub } from './core/interaction/pointer';
import { GestureService, statusLabel } from './core/gesture';
import { installMockBackend } from './core/mock/backend';
import { AudioScene } from './scenes/audio/audioScene';
import { NetworkScene } from './scenes/network/networkScene';
import { DiskScene } from './scenes/disk/diskScene';
import type { SceneContext, SceneModule } from './core/scene';
import type { SysInfo, Toast } from './core/types';

const EV_SCENE_CHANGE = 'vortex://scene/change';

class App implements AppHost {
  readonly prefs = new PrefsStore();
  readonly outputMode: boolean;
  readonly pointer = new PointerHub();
  readonly gesture: GestureService;

  #audio = new AudioBus();
  #engine: Engine;
  #hud: Hud;
  #scenes = new Map<SceneId, SceneModule>();
  #sys: SysInfo | null = null;
  #unlisteners: (() => void)[] = [];
  #booted = false;
  #lastGestureStatus = '';
  #lastTwoHandScale = 1;
  /** Когда жесты включились — от этого считаем «руку долго не видно». */
  #handsSince = 0;
  #handsHintShown = false;

  constructor(canvas: HTMLCanvasElement, outputMode: boolean, params: URLSearchParams) {
    this.outputMode = outputMode;
    this.pointer.attach(canvas);
    this.#engine = new Engine(canvas, this.prefs, this.#audio);

    const context: SceneContext = {
      audio: this.#audio,
      prefs: this.prefs,
      mode: outputMode ? 'output' : 'main',
      pointer: this.pointer,
      gesture: (this.gesture = new GestureService({ prefs: this.prefs, pointer: this.pointer })),
      hud: (this.#hud = new Hud(
        outputMode ? document.createElement('div') : document.getElementById('hud-root')!,
        this.#engine,
        this,
        this.prefs,
      )),
      toast: (kind, message) => this.#hud.toast(kind, message),
      confirm: (options) => this.#hud.confirm(options),
      requestResize: () => this.#engine.invalidate(),
    };

    this.#scenes.set('audio', new AudioScene(context));
    this.#scenes.set('network', new NetworkScene(context));
    this.#scenes.set('disk', new DiskScene(context));
    for (const scene of this.#scenes.values()) this.#engine.register(scene);

    // Смена сцены: пересобираем панель HUD, оповещаем окно вывода.
    // Вызываем обработчик вручную — при регистрации первой сцены его ещё не было.
    this.#engine.onSceneChange = (id) => this.#handleSceneChange(id);
    this.#handleSceneChange(this.#engine.currentId ?? this.prefs.get().scene);

    // Слой жестов обновляется ДО сцен: сцены должны видеть актуальный курсор в этом же кадре.
    this.#engine.addFrameHook((dt) => {
      // FPS отрисовки передаём в слой жестов: он сам снижает частоту распознавания,
      // если картинка просела (модель и рендер делят один GPU).
      this.gesture.update(dt, this.#engine.stats.fps);
      this.#applyTwoHandControl();
      this.#syncGestureStatus();
    });

    this.#unlisteners.push(
      listen<Toast>('vortex://toast', (toast) => this.#hud.toast(toast.kind, toast.message)),
      listen<SysInfo>('vortex://sys/info', (info) => {
        this.#sys = info;
        this.#hud.refresh();
      }),
      listen<{ scene: SceneId }>(EV_SCENE_CHANGE, (payload) => {
        // Окно вывода следует за главным.
        if (outputMode && payload?.scene) this.setScene(payload.scene);
      }),
      this.prefs.subscribe((prefs, changed) => {
        this.#hud.refresh();
        this.#engine.invalidate();
        if (changed.includes('paused')) this.#syncGesturePause(prefs.paused);
      }),
    );

    this.#wireGestures(params);

    if (outputMode) {
      document.getElementById('boot')?.classList.add('hidden');
      this.#hud.root.style.display = 'none';
    }
  }

  /* ─────────────────────────── Жесты ─────────────────────────── */

  /**
   * Связка жестов с приложением:
   *  • свайп ладонью → соседняя сцена (с уже готовым «пролётом» камеры);
   *  • открытая ладонь (удержание) → пауза;
   *  • кулак (удержание) → сброс камеры/раскладки сцены;
   *  • большой палец вверх → действие в контексте сцены.
   */
  #wireGestures(params: URLSearchParams): void {
    this.gesture.onEvent((name) => {
      if (this.outputMode) return;
      switch (name) {
        // Свайпы и «пауза ладонью» намеренно не обрабатываются: они срабатывали случайно
        // (пользователь: «убери пролистывание и почему-то на паузу ставится»). Детекторы
        // остаются в контроллере и включаются префами handSwipeScenes / handPauseGesture.
        case 'fist-reset': {
          const module = this.#engine.currentModule;
          module?.resetView?.();
          this.#hud.toast('info', 'Раскладка сброшена жестом «кулак»');
          break;
        }
        case 'thumbs-up': {
          const module = this.#engine.currentModule;
          if (module?.onGesture?.('thumbs-up')) break;
          this.#hud.toast('info', 'Сцена не использует жест «класс»');
          break;
        }
        case 'hand-lost':
          this.gesture.setGrabbed(false);
          this.gesture.setTether(null);
          break;
        default:
          break;
      }
    });

    this.gesture.onStatus((status, state) => {
      // «Ручной» демо-режим (преф или ?hand=demo) — это не ошибка: так и просили.
      const manualDemo = this.prefs.get().handDemo;
      if (status.phase === 'running' && this.#lastGestureStatus !== 'running') {
        this.#hud.toast(
          'info',
          manualDemo
            ? 'Демо-рука включена: кисть синтетическая, камера не используется'
            : 'Руки распознаются: щипок — вырвать узел и покрутить кистью, панель сцены покажет его запросы',
        );
      }
      if (status.phase === 'error' && this.#lastGestureStatus !== 'error') {
        this.#hud.toast('error', `Жесты недоступны: ${status.message ?? 'ошибка'}`, {
          action: { label: 'Открыть настройки', run: () => this.#hud.openSettings() },
        });
      }
      this.#lastGestureStatus = status.phase;
      void state;
    });

    // Включение: преф из настроек, либо параметры адреса (?hand=1 — камера, ?hand=demo — синтетика).
    const handParam = params.get('hand');
    if (handParam === 'demo') this.prefs.set({ handEnabled: true, handDemo: true, handShowSkeleton: true });
    else if (handParam === '1' || handParam === 'on') this.prefs.set({ handEnabled: true });
  }

  /**
   * Две руки: разведение — зум, поворот кистей — вращение сцены.
   * Контроллер отдаёт абсолютный масштаб от начала жеста, сцене нужен шаг за кадр.
   */
  #applyTwoHandControl(): void {
    const two = this.gesture.state.twoHand;
    if (!two.active) {
      this.#lastTwoHandScale = 1;
      return;
    }
    const step = two.scale / (this.#lastTwoHandScale || 1);
    this.#lastTwoHandScale = two.scale;
    if (Math.abs(step - 1) > 0.0005 || Math.abs(two.twist) > 0.0004) {
      this.#engine.currentModule?.controlOrbit?.(step, two.twist);
    }
  }

  #syncGesturePause(paused: boolean): void {
    // На паузе визуализации распознавание продолжается: жестами можно и паузу снять,
    // и переключить сцену. Камера гасится только при свёрнутом окне.
    void paused;
    this.gesture.setPaused(document.hidden);
  }

  /**
   * Если рука не попадала в кадр несколько секунд, показываем превью камеры: обычная причина
   * «жесты не работают» — рука вне кадра (слишком близко, сбоку, камера смотрит не туда).
   * Превью сразу отвечает на вопрос «камера меня вообще видит?».
   */
  #maybeOfferCameraPreview(): void {
    if (this.outputMode || this.#handsHintShown) return;
    if (!this.gesture.enabled) return;
    if (this.#handsSince === 0) {
      this.#handsSince = performance.now();
      return;
    }
    if (this.gesture.state.handsCount > 0) {
      this.#handsHintShown = true;
      return;
    }
    if (performance.now() - this.#handsSince < 8000) return;

    this.#handsHintShown = true;
    if (this.prefs.get().handShowPreview) return;
    this.#hud.toast('warn', 'Камера не видит кисть уже 8 секунд — включить превью камеры?', {
      action: {
        label: 'Показать превью',
        run: () => {
          this.prefs.set({ handShowPreview: true });
          this.#hud.toast('info', 'Держите раскрытую кисть в 40–80 см от камеры, ладонью к ней');
        },
      },
    });
  }

  #syncGestureStatus(): void {
    if (this.outputMode) return;
    const status = this.gesture.status;
    const state = this.gesture.state;
    this.#maybeOfferCameraPreview();
    const text = this.gesture.enabled
      ? `${statusLabel(status)}${state.handsCount > 0 ? ` · рук: ${state.handsCount}` : ''}${
          state.pose !== 'none' ? ` · ${poseLabel(state.pose)}` : ''
        }${state.grabbed ? ' · захват' : ''}`
      : 'жесты выключены (G)';
    this.#hud.setHandStatus(text, status.phase === 'error' ? 'error' : status.phase === 'running' ? 'ok' : '');
  }

  /* ─────────────────────────── AppHost ─────────────────────────── */

  setScene(id: SceneId): void {
    if (this.#engine.currentId === id) return;
    this.#engine.setScene(id);
    this.prefs.set({ scene: id });
  }

  currentScene(): SceneId {
    return (this.#engine.currentId ?? 'audio') as SceneId;
  }

  setMode(mode: AudioModeId): void {
    this.prefs.set({ audioMode: mode });
  }

  togglePause(): void {
    const paused = !this.prefs.get().paused;
    this.prefs.set({ paused });
    this.#hud.toast('info', paused ? 'Визуализация на паузе (Space)' : 'Визуализация продолжена');
  }

  toggleHud(): void {
    const visible = !this.prefs.get().hudVisible;
    this.prefs.set({ hudVisible: visible });
    this.#hud.setHudVisible(visible);
  }

  /** Включить/выключить управление жестами (кнопка HUD или клавиша G). */
  toggleHands(): void {
    const enabled = !this.prefs.get().handEnabled;
    this.prefs.set({ handEnabled: enabled });
    if (!enabled) {
      this.#hud.toast('info', 'Управление жестами выключено');
      return;
    }
    this.#hud.toast(
      'info',
      this.prefs.get().handDemo
        ? 'Демо-рука включена: синтетическая кисть, камера не нужна'
        : 'Включаю распознавание рук — разрешите доступ к камере, если Windows спросит',
    );
  }

  toggleFullscreen(): void {
    if (isTauri) {
      const next = !document.fullscreenElement;
      void invoke('toggle_main_fullscreen', { fullscreen: next }).catch(() => undefined);
      return;
    }
    void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(
      () => this.#hud.toast('warn', 'Полноэкранный режим недоступен'),
    );
  }

  toggleOutputWindow(): void {
    if (!isTauri) {
      this.#hud.toast('warn', 'Второе окно вывода доступно в сборке Tauri');
      return;
    }
    const open = this.#engine.currentId !== null;
    void invoke(open ? 'open_output_window' : 'close_output_window', {}).catch((err) =>
      this.#hud.toast('error', `Окно вывода: ${String(err)}`),
    );
  }

  toggleSettings(): void {
    this.#hud.toggleSettings();
  }

  info() {
    const prefs = this.prefs.get();
    const scene = this.#scenes.get(this.currentScene());
    const source = this.#audio.snapshot.source;
    const sourceLabel =
      source === 'system'
        ? 'WASAPI · СИСТЕМНЫЙ ЗВУК'
        : source === 'mic'
          ? 'МИКРОФОН'
          : this.#audio.info.device?.includes('Демо')
            ? 'ДЕМО-СПЕКТР'
            : 'НЕТ ЗВУКА';
    return {
      os: this.#sys?.os ?? (isTauri ? 'windows' : 'browser (демо)'),
      elevated: Boolean(this.#sys?.elevated),
      version: this.#sys?.appVersion ?? '0.1.0',
      sourceLabel,
      sceneTitle: scene?.title ?? '—',
      modeLabel: scene?.modeLabel() ?? '—',
      paused: prefs.paused,
      hudVisible: prefs.hudVisible,
      hands: prefs.handEnabled,
    };
  }

  dispose(): void {
    for (const off of this.#unlisteners) off();
    this.gesture.dispose();
    this.pointer.dispose();
    this.#engine.dispose();
    this.#audio.dispose();
  }

  /** Пересобрать панель активной сцены и синхронизировать окно вывода. */
  #handleSceneChange(id: SceneId): void {
    this.#hud.setScenePanel(this.#scenes.get(id)?.hudPanel?.() ?? null);
    this.#hud.refresh();
    if (this.outputMode || !isTauri) return;
    // Событие уходит во все окна приложения, включая окно вывода.
    void import('@tauri-apps/api/event').then(({ emit }) => emit(EV_SCENE_CHANGE, { scene: id }));
  }

  async boot(): Promise<void> {
    if (this.#booted) return;
    this.#booted = true;

    try {
      this.#sys = await invoke<SysInfo>('sys_info');
    } catch {
      this.#sys = null;
    }

    // Стартовая сцена: из настроек, для окна вывода — тоже.
    this.#engine.setScene(this.prefs.get().scene);
    this.#engine.start();
    this.#hud.refresh();

    // Жесты: включаем, если так просили настройки или параметры адреса.
    if (!this.outputMode && this.prefs.get().handEnabled) {
      void this.gesture.setEnabled(true);
    }
    document.addEventListener('visibilitychange', () => this.gesture.setPaused(document.hidden));

    // HUD обновляем 4 раза в секунду: чаще — только зря греет CPU.
    window.setInterval(() => {
      this.#hud.updateStats();
      this.#hud.updateSpark(performance.now());
    }, 250);

    document.getElementById('boot')?.classList.add('hidden');
  }
}

function poseLabel(pose: string): string {
  switch (pose) {
    case 'pinch':
      return 'щипок';
    case 'open':
      return 'ладонь';
    case 'fist':
      return 'кулак';
    case 'thumbsUp':
      return 'класс';
    case 'point':
      return 'указание';
    default:
      return '—';
  }
}

/* ─────────────────────────── Старт ─────────────────────────── */

async function main(): Promise<void> {
  installMockBackend();

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const params = new URLSearchParams(window.location.search);

  // Окно вывода: тот же бандл, но без HUD. В Tauri метка окна доступна через API.
  let outputMode = params.get('window') === 'output';
  if (!outputMode && isTauri) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      outputMode = getCurrentWindow().label === 'output';
    } catch {
      outputMode = false;
    }
  }

  const app = new App(canvas, outputMode, params);
  (window as unknown as { vortex: App }).vortex = app;

  // Даём браузеру показать первый кадр, затем убираем экран загрузки.
  await app.boot();
}

void main();
