/**
 * Фасад слоя жестов: включает/выключает источник рук, прокидывает состояние в указатель,
 * рисует оверлей и рассылает командные жесты приложению.
 *
 * Разделение получилось такое:
 * ```
 *   HandSource (камера | демо)  ──кадры 30 Гц──►  GestureController ──состояние 60 Гц──► сцены
 *                                                        │
 *                                                        ├──► PointerHub  (курсор+щипок = мышь)
 *                                                        ├──► GestureOverlay (скелет, курсор)
 *                                                        └──► события: свайп, пауза, сброс, «класс»
 * ```
 */

import { CameraHandSource } from './handTracker';
import { DemoHandSource } from './demoHand';
import { GestureController } from './gestureController';
import { GestureOverlay } from './overlay';
import type { GestureName, GestureState, HandFrame, HandSource, SourceStatus } from './types';

import type { PointerHub } from '../interaction/pointer';
import type { PrefsStore } from '../prefs';

export interface GestureServiceOptions {
  prefs: PrefsStore;
  pointer: PointerHub;
}

export class GestureService {
  readonly controller: GestureController;

  #prefs: PrefsStore;
  #pointer: PointerHub;
  #overlay: GestureOverlay;
  #source: HandSource | null = null;
  #status: SourceStatus = { phase: 'off' };
  #frameUnsub: (() => void) | null = null;
  #statusUnsub: (() => void) | null = null;
  #enabled = false;
  #paused = false;
  #starting = false;
  /** Камера не далась (нет устройства, запрет доступа) — показываем демо-руку. */
  #autoDemo = false;
  #demoReason = '';

  #eventListeners = new Set<(name: GestureName | 'hand-lost') => void>();
  #statusListeners = new Set<(status: SourceStatus, state: GestureState) => void>();

  constructor(options: GestureServiceOptions) {
    this.#prefs = options.prefs;
    this.#pointer = options.pointer;

    const prefs = options.prefs.get();
    this.controller = new GestureController({
      mirror: prefs.handMirror,
      sensitivity: prefs.handSensitivity,
      smoothing: prefs.handSmoothing,
      pauseGesture: prefs.handPauseGesture,
    });
    // Контроллер владеет разбором жестов, сервис — их рассылкой.
    this.#forwardControllerEvents();

    this.#overlay = new GestureOverlay();

    this.#prefs.subscribe((current, changed) => this.#onPrefsChanged(current, changed));
    window.addEventListener('resize', this.#onResize);
  }

  get state(): GestureState {
    return this.controller.state;
  }

  get status(): SourceStatus {
    return this.#status;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get overlay(): GestureOverlay {
    return this.#overlay;
  }

  /** Подписка на командные жесты (свайп, пауза ладонью, сброс кулаком, «класс»). */
  onEvent(listener: (name: GestureName | 'hand-lost') => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Подписка на статус (загрузка модели, ошибки, FPS) — используется HUD. */
  onStatus(listener: (status: SourceStatus, state: GestureState) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status, this.controller.state);
    return () => this.#statusListeners.delete(listener);
  }

  /** Взят ли объект сценой (для отрисовки захвата и линии «рука↔объект»). */
  setGrabbed(grabbed: boolean): void {
    this.controller.setGrabbed(grabbed);
  }

  /** Сцена сообщает, где сейчас «привязанный» объект (экранные координаты). */
  setTether(point: { x: number; y: number } | null): void {
    this.#overlay.setTether(point);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.#enabled && this.#source) return;
    this.#enabled = enabled;

    if (!enabled) {
      this.#teardownSource();
      this.#pointer.clearHand();
      this.controller.reset();
      this.#overlay.setVisible(false);
      this.#emitStatus({ phase: 'off' });
      return;
    }

    await this.#startSource();
  }

  /**
   * Пауза распознавания (свёрнутое окно, пауза визуализации): камера выключается,
   * индикатор в браузере гаснет — это важно и для приватности, и для CPU.
   */
  setPaused(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    if (!this.#enabled) return;
    if (paused) {
      this.#teardownSource();
      this.#pointer.clearHand();
      this.#emitStatus({ ...this.#status, phase: 'off', message: 'пауза' });
    } else {
      void this.#startSource();
    }
  }

  /** Кадр движка: обновить состояние, прокид в указатель и отрисовку оверлея. */
  update(dt: number): void {
    if (!this.#enabled) return;
    this.controller.update(dt);

    const state = this.controller.state;
    if (state.cursor.active) {
      this.#pointer.setHandPointer(state.cursor.ndcX, state.cursor.ndcY, true);
      this.#pointer.setHandPress(state.pinch.active);
    } else {
      this.#pointer.clearHand();
    }

    const prefs = this.#prefs.get();
    this.#overlay.render(state, {
      mirror: prefs.handMirror,
      showSkeleton: prefs.handShowSkeleton,
      showPreview: prefs.handShowPreview,
      mapToNdc: (x, y) => this.controller.mapToNdc(x, y),
      statusText: statusLabel(this.#status),
      handCount: state.handsCount,
      hint: hintForStatus(this.#status),
    });
  }

  dispose(): void {
    this.#teardownSource();
    this.#overlay.dispose();
    window.removeEventListener('resize', this.#onResize);
    this.#eventListeners.clear();
    this.#statusListeners.clear();
  }

  /* ─────────────────────────── Внутреннее ─────────────────────────── */

  async #startSource(): Promise<void> {
    if (this.#starting) return;
    this.#starting = true;
    this.#teardownSource();

    const prefs = this.#prefs.get();
    const source: HandSource = prefs.handDemo ? new DemoHandSource() : new CameraHandSource();
    this.#source = source;

    this.#frameUnsub = source.onFrame((frame) => this.#onFrame(frame));
    this.#statusUnsub = source.onStatus((status) => {
      this.#status = this.#autoDemo
        ? { ...status, message: status.message ? `${status.message} · демо: ${this.#demoReason}` : `демо: ${this.#demoReason}` }
        : status;
      if (this.#autoDemo) this.#status.phase = 'running';
      this.#overlay.video = source.kind === 'camera' ? (source as CameraHandSource).videoElement : null;
      this.#emitStatus(status);
    });
    this.#overlay.setVisible(prefs.handShowSkeleton || prefs.handShowPreview);

    try {
      await source.start();
      this.#demoReason = '';
      this.#autoDemo = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Камера/модель не дались — не оставляем пользователя с пустым экраном и непонятной
      // ошибкой: переключаемся на синтетическую руку и честно говорим, почему.
      if (!prefs.handDemo) {
        this.#autoDemo = true;
        this.#demoReason = message;
        console.warn(`[gesture] камера недоступна (${message}) — включаю демо-руку`);
        this.#emitStatus({ phase: 'running', message: `демо: ${message}`, delegate: 'CPU' });
        await this.#startDemoSource();
      } else {
        this.#emitStatus({ phase: 'error', message });
      }
    } finally {
      this.#starting = false;
    }
  }

  /** Переключение на синтетическую руку (та же логика жестов, но без камеры и модели). */
  async #startDemoSource(): Promise<void> {
    const source = new DemoHandSource();
    this.#source = source;
    this.#frameUnsub = source.onFrame((frame) => this.#onFrame(frame));
    this.#statusUnsub = source.onStatus((status) => {
      this.#status = { ...status, message: `демо-рука: ${this.#demoReason}` };
      this.#emitStatus(this.#status);
    });
    this.#overlay.setVisible(this.#prefs.get().handShowSkeleton || this.#prefs.get().handShowPreview);
    await source.start();
  }

  #teardownSource(): void {
    this.#frameUnsub?.();
    this.#statusUnsub?.();
    this.#frameUnsub = null;
    this.#statusUnsub = null;
    this.#source?.stop();
    this.#source = null;
    this.#overlay.video = null;
  }

  #onFrame(frame: HandFrame): void {
    this.controller.push(frame);
    this.#overlay.pushFrame(frame);
  }

  #onPrefsChanged(prefs: ReturnType<PrefsStore['get']>, changed: (keyof ReturnType<PrefsStore['get']>)[]): void {
    const handKeys = changed.filter((key) => String(key).startsWith('hand'));
    if (handKeys.length === 0) return;

    this.controller.setOptions({
      mirror: prefs.handMirror,
      sensitivity: prefs.handSensitivity,
      smoothing: prefs.handSmoothing,
      pauseGesture: prefs.handPauseGesture,
    });

    if (changed.includes('handShowSkeleton') || changed.includes('handShowPreview')) {
      this.#overlay.setVisible(prefs.handShowSkeleton || prefs.handShowPreview);
    }

    // Смена источника (камера ↔ демо) требует перезапуска и снимает авто-подмену.
    if (changed.includes('handDemo') && this.#enabled) {
      this.#autoDemo = false;
      this.#demoReason = '';
      void this.#startSource();
    }

    if (changed.includes('handEnabled')) void this.setEnabled(prefs.handEnabled);
  }

  #forwardControllerEvents(): void {
    // Контроллер отдаёт имена жестов — превращаем их в подписки сервиса.
    const names: (GestureName | 'hand-lost')[] = [
      'swipe-left',
      'swipe-right',
      'palm-pause',
      'fist-reset',
      'thumbs-up',
      'hand-lost',
    ];
    for (const name of names) {
      this.controller.on(name, () => {
        for (const listener of this.#eventListeners) listener(name);
      });
    }
  }

  #emitStatus(status: SourceStatus): void {
    for (const listener of this.#statusListeners) listener(status, this.controller.state);
  }

  #onResize = (): void => {
    this.#overlay.resize();
  };
}

/**
 * Что делать, если жестов не видно: вторая строка на плашке состояния.
 * Тексты намеренно короткие — плашка должна читаться с одного взгляда.
 */
export function hintForStatus(status: SourceStatus): string {
  if (status.phase === 'error') return 'настройки (S) → «Демо-рука» покажет жесты без камеры';
  if (status.phase === 'running' && status.message?.includes('демо')) {
    return 'демо-рука: синтетический сценарий, камера не используется';
  }
  if (status.phase === 'running') return 'держите кисть в 40–80 см от камеры';
  return '';
}

export function statusLabel(status: SourceStatus): string {
  switch (status.phase) {
    case 'off':
      return status.message ?? 'жесты выключены';
    case 'loading-wasm':
      return 'загружаю WASM…';
    case 'loading-model':
      return 'загружаю модель…';
    case 'starting-camera':
      return status.message ?? 'включаю камеру…';
    case 'running':
      return `жесты · ${Math.round(status.fps ?? 0)} FPS · ${status.delegate ?? 'CPU'}${
        status.modelSource ? ` · модель: ${status.modelSource}` : ''
      }`;
    case 'error':
      return `ошибка: ${status.message ?? 'неизвестно'}`;
    default:
      return '—';
  }
}

export type { GestureName, GestureState, SourceStatus };
