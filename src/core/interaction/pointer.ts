/**
 * Унифицированный указатель: мышь и рука — один источник для сцен.
 *
 * Раньше каждая сцена сама слушала pointermove/pointerdown. С появлением жестов это стало
 * плохо: у нас появляется второй «указатель» (кончик пальца), который обязан вести себя так же
 * (наведение, нажатие, отпускание). Теперь сцены читают `PointerHub`, а кто именно управляет —
 * мышь или рука — деталь реализации.
 *
 * Нажатие руки = щипок: слой жестов вызывает `setHandPress(true/false)`.
 */

import { TypedEmitter } from '../events';

export type PointerSource = 'mouse' | 'hand' | null;

export interface PointerSnapshot {
  ndcX: number;
  ndcY: number;
  screenX: number;
  screenY: number;
  /** Есть ли валидный указатель вообще (мышь в окне или рука в кадре). */
  active: boolean;
  source: PointerSource;
  /** Идёт нажатие (ЛКМ или удержание щипка). */
  pressed: boolean;
}

export interface PointerEventPayload extends PointerSnapshot {
  source: Exclude<PointerSource, null>;
  /** Для мыши — номер кнопки, для руки всегда 0. */
  button: number;
}

interface PointerEvents extends Record<string, unknown> {
  move: PointerEventPayload;
  press: PointerEventPayload;
  release: PointerEventPayload;
  /** Короткое нажатие без заметного перемещения — «клик». */
  click: PointerEventPayload;
}

const CLICK_TIME_MS = 320;
const CLICK_SLOP_NDC = 0.04;

export class PointerHub {
  readonly state: PointerSnapshot = {
    ndcX: 0,
    ndcY: 0,
    screenX: 0,
    screenY: 0,
    active: false,
    source: null,
    pressed: false,
  };

  #emitter = new TypedEmitter<PointerEvents>();
  #detach: (() => void) | null = null;
  #pressStartedAt = 0;
  #pressOrigin = { x: 0, y: 0 };
  #movedWhilePressed = false;
  #width = 1;
  #height = 1;

  attach(element: HTMLElement): void {
    this.detach();

    const toNdc = (event: PointerEvent | MouseEvent) => {
      const rect = element.getBoundingClientRect();
      this.#width = rect.width || 1;
      this.#height = rect.height || 1;
      return {
        ndcX: ((event.clientX - rect.left) / this.#width) * 2 - 1,
        ndcY: -(((event.clientY - rect.top) / this.#height) * 2 - 1),
        screenX: event.clientX,
        screenY: event.clientY,
      };
    };

    const onMove = (event: PointerEvent) => {
      const point = toNdc(event);
      Object.assign(this.state, point, { active: true, source: 'mouse' as const });
      if (this.state.pressed) {
        if (Math.hypot(point.ndcX - this.#pressOrigin.x, point.ndcY - this.#pressOrigin.y) > CLICK_SLOP_NDC) {
          this.#movedWhilePressed = true;
        }
      }
      this.#emitter.emit('move', this.#payload('mouse', event.button));
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const point = toNdc(event);
      Object.assign(this.state, point, { active: true, source: 'mouse' as const, pressed: true });
      this.#pressStartedAt = performance.now();
      this.#pressOrigin = { x: point.ndcX, y: point.ndcY };
      this.#movedWhilePressed = false;
      this.#emitter.emit('press', this.#payload('mouse', event.button));
    };

    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || !this.state.pressed || this.state.source !== 'mouse') return;
      const point = toNdc(event);
      Object.assign(this.state, point, { pressed: false });
      const payload = this.#payload('mouse', event.button);
      this.#emitter.emit('release', payload);
      const duration = performance.now() - this.#pressStartedAt;
      if (!this.#movedWhilePressed && duration < CLICK_TIME_MS) this.#emitter.emit('click', payload);
    };

    const onLeave = () => {
      if (this.state.source === 'mouse') this.state.active = false;
    };

    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('pointerleave', onLeave);

    this.#detach = () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('pointerleave', onLeave);
    };
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
  }

  /**
   * Обновление указателя рукой. Вызывается слоем жестов каждый кадр.
   * Курсор приходит в NDC; пиксельные координаты считаем от размера окна.
   */
  setHandPointer(ndcX: number, ndcY: number, active: boolean): void {
    // Мышь во время работы руки не должна «перебивать» её: пока источник hand, события мыши
    // продолжают обновлять состояние только если рука пропала.
    if (this.state.source === 'mouse' && active && this.state.active && this.state.pressed) return;
    Object.assign(this.state, {
      ndcX,
      ndcY,
      screenX: (ndcX * 0.5 + 0.5) * (this.#width || window.innerWidth),
      screenY: (-ndcY * 0.5 + 0.5) * (this.#height || window.innerHeight),
      active,
      source: active ? ('hand' as const) : this.state.source,
    });
  }

  setHandPress(pressed: boolean): void {
    if (this.state.source !== 'hand') return;
    if (pressed === this.state.pressed) return;
    this.state.pressed = pressed;
    if (pressed) {
      this.#pressStartedAt = performance.now();
      this.#pressOrigin = { x: this.state.ndcX, y: this.state.ndcY };
      this.#movedWhilePressed = false;
      this.#emitter.emit('press', this.#payload('hand', 0));
    } else {
      const payload = this.#payload('hand', 0);
      this.#emitter.emit('release', payload);
      const duration = performance.now() - this.#pressStartedAt;
      if (!this.#movedWhilePressed && duration < 700) this.#emitter.emit('click', payload);
    }
  }

  /** Рука ушла из кадра: снимаем указатель и, если было нажатие, отпускаем его. */
  clearHand(): void {
    if (this.state.source !== 'hand') return;
    this.setHandPress(false);
    this.state.active = false;
    this.state.source = null;
  }

  onMove(listener: (payload: PointerEventPayload) => void): () => void {
    return this.#emitter.on('move', listener);
  }

  onPress(listener: (payload: PointerEventPayload) => void): () => void {
    return this.#emitter.on('press', listener);
  }

  onRelease(listener: (payload: PointerEventPayload) => void): () => void {
    return this.#emitter.on('release', listener);
  }

  onClick(listener: (payload: PointerEventPayload) => void): () => void {
    return this.#emitter.on('click', listener);
  }

  dispose(): void {
    this.detach();
    this.#emitter.clear();
  }

  #payload(source: 'mouse' | 'hand', button: number): PointerEventPayload {
    return { ...this.state, active: true, source, button };
  }
}
