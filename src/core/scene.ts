/**
 * Модуль сцены — контракт между рендер-ядром и конкретной визуализацией.
 *
 * Каждая сцена полностью независима: свой THREE.Scene, своя камера, свои ресурсы.
 * Ядро лишь чередует их и передаёт прогресс перехода, чтобы сцена сама «улетала»/«прилетала».
 */

import type * as THREE from 'three';
import type { AudioBus } from './audio/bus';
import type { Hud } from './hud/hud';
import type { PrefsStore, SceneId } from './prefs';

export type { SceneId };

/** Состояние сцены внутри кадра. */
export interface SceneState {
  /** Сцена сейчас на переднем плане и завершила переход (можно принимать ввод). */
  active: boolean;
  /** Прогресс «влёта» 0…1 (1 — сцена стоит на месте). */
  enter: number;
  /** Направление перехода: +1 вправо, -1 влево. */
  dir: number;
  /** true, если сцена уезжает (переход начался с неё). */
  outgoing: boolean;
  /** Пользователь поставил визуализацию на паузу (Space). */
  paused: boolean;
}

/** Что ядро даёт сцене (без доступа к внутренностям рендера). */
export interface SceneContext {
  audio: AudioBus;
  prefs: PrefsStore;
  hud: Hud;
  /**
   * 'main' — обычное окно (можно запускать сканы и опросы),
   * 'output' — безрамочное окно вывода на второй монитор: только рендер, без побочных эффектов.
   */
  mode: 'main' | 'output';
  /** Показывает тост в HUD. */
  toast(kind: 'info' | 'warn' | 'error', message: string): void;
  /** Спросить подтверждение (используется удалением в корзину). */
  confirm(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  /** Инвалидировать размеры (после смены DPR/качества). */
  requestResize(): void;
}

export interface SceneModule {
  readonly id: SceneId;
  readonly title: string;
  readonly subtitle: string;
  /** Подпись активного режима для HUD (например, «Частицы»). */
  modeLabel(): string;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;

  /** Вызывается при первом показе сцены: подписки, запуск провайдеров данных. */
  activate?(): void | Promise<void>;
  /** Вызывается, когда сцену скрыли (переход на другую или выход). */
  deactivate?(): void;

  update(dt: number, time: number, state: SceneState): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** Обработка клавиши (M — смена режима и т.п.). Вернуть true, если клавиша обработана. */
  onKey?(code: string): boolean;
  /** Панель сцены в HUD (создаётся ядром, владеет сценой). */
  hudPanel?(): HTMLElement;
  dispose(): void;
}
