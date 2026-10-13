/**
 * Типы слоя жестов. Специально без зависимости от MediaPipe: и «камера», и синтетический
 * демо-источник отдают один и тот же `HandFrame`, поэтому логика жестов тестируется в Node
 * и не знает, откуда пришли координаты.
 */

/** Одна точка кисти: x,y нормализованы в 0..1 (как в кадре камеры, y — вниз), z — относительная глубина. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** Одна распознанная рука. */
export interface HandObservation {
  landmarks: Landmark[];
  /// Метка MediaPipe («Left»/«Right»). Не используется для логики — только для подписи.
  handedness: 'Left' | 'Right' | 'Unknown';
  score: number;
}

/** Кадр распознавания. */
export interface HandFrame {
  hands: HandObservation[];
  /// Монотонные мс (performance.now()).
  timestampMs: number;
  /// Сколько заняло распознавание, мс.
  inferenceMs: number;
}

/** Источник кадров рук: реальная камера или демо-генератор. */
export interface HandSource {
  readonly kind: 'camera' | 'demo';
  readonly status: SourceStatus;
  start(): Promise<void>;
  stop(): void;
  onFrame(listener: (frame: HandFrame) => void): () => void;
  onStatus(listener: (status: SourceStatus) => void): () => void;
}

export type SourcePhase =
  | 'off'
  | 'loading-wasm'
  | 'loading-model'
  | 'starting-camera'
  | 'running'
  | 'error';

export interface SourceStatus {
  /** Откуда взялась модель (для диагностики в HUD). */
  modelSource?: string;
  phase: SourcePhase;
  message?: string;
  /// Реальный FPS распознавания.
  fps?: number;
  delegate?: 'GPU' | 'CPU';
  /// Размер кадра камеры.
  resolution?: string;
}

/** Поза кисти, распознанная по геометрии пальцев. */
export type HandPose = 'none' | 'open' | 'fist' | 'pinch' | 'point' | 'thumbsUp';

/** Дискретные жесты, которые ловит контроллер. */
export type GestureName = 'swipe-left' | 'swipe-right' | 'palm-pause' | 'fist-reset' | 'thumbs-up';

/** Курсор, управляемый рукой (в NDC и в пикселях экрана). */
export interface CursorState {
  active: boolean;
  ndcX: number;
  ndcY: number;
  screenX: number;
  screenY: number;
}

/** Полное состояние слоя жестов на текущий кадр — это читают сцены. */
export interface GestureState {
  enabled: boolean;
  handsCount: number;
  pose: HandPose;
  cursor: CursorState;
  /** Щипок: strength 0..1, active — с гистерезисом, progress — заполнение кольца удержания. */
  pinch: { strength: number; active: boolean; progress: number };
  /** Сцена сообщает, что «взяла» объект (тогда курсор рисует захват). */
  grabbed: boolean;
  /** Две руки: зум и поворот сцены. */
  twoHand: { active: boolean; scale: number; twist: number; centerX: number; centerY: number };
  /** Подпись текущего удержания («пауза», «сброс», «действие») и его прогресс 0..1. */
  holdLabel: string | null;
  holdProgress: number;
  /** Вторая рука (для сцен, которым нужна отдельная логика). */
  secondaryCursor: CursorState;
  secondaryPinch: boolean;
}
