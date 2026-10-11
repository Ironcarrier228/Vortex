/**
 * Точка входа VORTEX.
 *
 * Приложение собирается как `App`, который:
 *  • создаёт рендер-ядро, HUD и аудиошину;
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
  #audio = new AudioBus();
  #engine: Engine;
  #hud: Hud;
  #scenes = new Map<SceneId, SceneModule>();
  #sys: SysInfo | null = null;
  #unlisteners: (() => void)[] = [];
  #booted = false;

  constructor(canvas: HTMLCanvasElement, outputMode: boolean) {
    this.outputMode = outputMode;
    this.#engine = new Engine(canvas, this.prefs, this.#audio);

    const context: SceneContext = {
      audio: this.#audio,
      prefs: this.prefs,
      mode: outputMode ? 'output' : 'main',
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
      this.prefs.subscribe(() => {
        this.#hud.refresh();
        this.#engine.invalidate();
      }),
    );

    if (outputMode) {
      document.getElementById('boot')?.classList.add('hidden');
      this.#hud.root.style.display = 'none';
    }
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

    // HUD обновляем 4 раза в секунду: чаще — только зря греет CPU.
    window.setInterval(() => {
      this.#hud.updateStats();
      this.#hud.updateSpark(performance.now());
    }, 250);

    document.getElementById('boot')?.classList.add('hidden');
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
    };
  }

  dispose(): void {
    for (const off of this.#unlisteners) off();
    this.#engine.dispose();
    this.#audio.dispose();
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

  const app = new App(canvas, outputMode);
  (window as unknown as { vortex: App }).vortex = app;

  // Даём браузеру показать первый кадр, затем убираем экран загрузки.
  await app.boot();
}

void main();
