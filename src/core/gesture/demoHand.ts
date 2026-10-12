/**
 * Демо-источник рук: синтетические кадры без камеры и без модели.
 *
 * Нужен в трёх случаях:
 *  • показать жест-управление в песочнице/превью, где камера недоступна;
 *  • отладить сам слой жестов (курсор, щипок, свайпы) без «живой» руки;
 *  • научить новых пользователей: рука сама показывает щипок, ладонь и «класс».
 *
 * Включается префом `handDemo` или параметром адреса `?hand=demo`.
 */

import { makeSyntheticHand } from './landmarks';
import type { HandFrame, HandObservation, HandSource, SourceStatus } from './types';

/** Сценарная дорожка демо-руки: что показывает синтетическая кисть. */
type DemoBeat = 'cruise' | 'pinch' | 'two-hands' | 'open-palm' | 'thumbs-up';

const BEAT_DURATION: Record<DemoBeat, number> = {
  cruise: 5,
  pinch: 3.4,
  'two-hands': 4,
  'open-palm': 2.6,
  'thumbs-up': 2.2,
};

export class DemoHandSource implements HandSource {
  readonly kind = 'demo' as const;
  status: SourceStatus = { phase: 'off' };

  #frameListeners = new Set<(frame: HandFrame) => void>();
  #statusListeners = new Set<(status: SourceStatus) => void>();
  #handle = 0;
  #running = false;
  #startedAt = 0;
  #lastFrameAt = 0;
  #fpsEma = 0;

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = performance.now();
    this.#lastFrameAt = this.#startedAt;
    this.#setStatus({ phase: 'running', message: 'демо-рука (без камеры)', fps: 30, delegate: 'CPU', resolution: 'синтетика 640×480' });
    this.#loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#handle) cancelAnimationFrame(this.#handle);
    this.#handle = 0;
    this.#setStatus({ phase: 'off' });
  }

  onFrame(listener: (frame: HandFrame) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onStatus(listener: (status: SourceStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.status);
    return () => this.#statusListeners.delete(listener);
  }

  #setStatus(status: SourceStatus): void {
    this.status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #loop = (): void => {
    if (!this.#running) return;
    this.#handle = requestAnimationFrame(this.#loop);

    const now = performance.now();
    const dtMs = now - this.#lastFrameAt;
    if (dtMs < 1000 / 30) return; // держим «30 FPS распознавания», как у реальной модели
    this.#lastFrameAt = now;

    const elapsed = (now - this.#startedAt) / 1000;
    const instantFps = 1000 / Math.max(dtMs, 1);
    this.#fpsEma = this.#fpsEma === 0 ? instantFps : this.#fpsEma * 0.9 + instantFps * 0.1;

    const frame: HandFrame = {
      hands: this.#buildHands(elapsed),
      timestampMs: now,
      inferenceMs: 3.5,
    };
    for (const listener of this.#frameListeners) listener(frame);
    this.#setStatus({ ...this.status, fps: this.#fpsEma });
  };

  /** Сценарий: плавный «пролёт» → щипок → две руки → ладонь → «класс» → снова пролёт. */
  #beatAt(elapsed: number): { beat: DemoBeat; t: number } {
    const order: DemoBeat[] = ['cruise', 'pinch', 'two-hands', 'open-palm', 'thumbs-up'];
    const total = order.reduce((sum, beat) => sum + BEAT_DURATION[beat], 0);
    let rest = elapsed % total;
    for (const beat of order) {
      if (rest < BEAT_DURATION[beat]) return { beat, t: rest / BEAT_DURATION[beat] };
      rest -= BEAT_DURATION[beat];
    }
    return { beat: 'cruise', t: 0 };
  }

  #buildHands(elapsed: number): HandObservation[] {
    const { beat, t } = this.#beatAt(elapsed);
    const hands: HandObservation[] = [];

    // Базовая траектория основной руки: «ленивая восьмёрка» по кадру.
    const cx = 0.5 + Math.sin(elapsed * 0.55) * 0.22;
    const cy = 0.52 + Math.sin(elapsed * 1.1) * 0.16;

    const makeObservation = (
      landmarks: HandObservation['landmarks'],
      handedness: HandObservation['handedness'],
    ): HandObservation => ({ landmarks, handedness, score: 0.95 });

    if (beat === 'two-hands') {
      // Две руки расходятся и сходятся, слегка поворачиваясь — демонстрация зума и вращения.
      const spread = 0.16 + Math.abs(Math.sin(t * Math.PI)) * 0.14;
      const tilt = Math.sin(elapsed * 0.8) * 0.35;
      hands.push(
        makeObservation(
          makeSyntheticHand({
            centerX: 0.5 - spread,
            centerY: 0.55,
            size: 0.2,
            rotation: 0.35 + tilt,
            openness: 0.95,
          }),
          'Right',
        ),
        makeObservation(
          makeSyntheticHand({
            centerX: 0.5 + spread,
            centerY: 0.5,
            size: 0.2,
            rotation: -0.35 - tilt,
            openness: 0.95,
          }),
          'Left',
        ),
      );
      return hands;
    }

    const pinch = beat === 'pinch' ? Math.min(1, Math.max(0, Math.sin(t * Math.PI) * 1.6)) : 0;
    const thumbsUp = beat === 'thumbs-up';
    const openness = beat === 'open-palm' ? 1 : thumbsUp ? 0.12 : 0.72;

    hands.push(
      makeObservation(
        makeSyntheticHand({
          centerX: cx,
          centerY: cy,
          size: 0.2,
          rotation: Math.sin(elapsed * 0.4) * 0.3,
          openness,
          pinch,
          thumbsUp,
        }),
        'Right',
      ),
    );

    // Иногда показываем «вторую руку на подходе», чтобы HUD видел 2 руки.
    if (beat === 'cruise' && t > 0.75) {
      hands.push(
        makeObservation(
          makeSyntheticHand({
            centerX: 0.18 + (t - 0.75) * 0.4,
            centerY: 0.62,
            size: 0.19,
            rotation: 0.5,
            openness: 0.9,
          }),
          'Left',
        ),
      );
    }
    return hands;
  }
}
