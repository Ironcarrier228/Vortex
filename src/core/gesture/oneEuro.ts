/**
 * One Euro Filter — стандартный способ убрать дрожание рук, не добавляя заметной задержки.
 *
 * Идея: частота среза фильтра растёт вместе со скоростью движения. Медленное движение
 * фильтруется сильно (дрожание исчезает), быстрое — почти без задержки (рука не «плывёт»).
 * Для управления 3D-курсором это ровно то, что нужно: экспоненциальное сглаживание с
 * фиксированным коэффициентом либо дрожит, либо запаздывает.
 *
 * Источник подхода: Casiez et al., «1€ Filter» (CHI 2012).
 */

class LowPass {
  #y = 0;
  #initialized = false;

  filter(value: number, alpha: number): number {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#y = value;
      return value;
    }
    this.#y = alpha * value + (1 - alpha) * this.#y;
    return this.#y;
  }

  get value(): number {
    return this.#y;
  }

  reset(): void {
    this.#initialized = false;
    this.#y = 0;
  }

  get initialized(): boolean {
    return this.#initialized;
  }
}

const TWO_PI = Math.PI * 2;

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  #minCutoff: number;
  #beta: number;
  #dCutoff: number;
  #x = new LowPass();
  #dx = new LowPass();
  #lastTime = 0;
  #lastRaw = 0;

  /**
   * @param minCutoff базовая частота среза (меньше — глаже и медленнее), Гц
   * @param beta насколько сильно скорость увеличивает срез (больше — меньше запаздывание)
   * @param dCutoff частота среза для оценки скорости
   */
  constructor(minCutoff = 1.1, beta = 0.02, dCutoff = 1.0) {
    this.#minCutoff = minCutoff;
    this.#beta = beta;
    this.#dCutoff = dCutoff;
  }

  /** Настроить гладкость: `smoothing` 0…0.95 (0 — почти без фильтра, 0.95 — максимально плавно). */
  setSmoothing(smoothing: number): void {
    const clamped = Math.min(0.95, Math.max(0, smoothing));
    // Большое сглаживание → низкий срез; beta слегка растёт, чтобы рука не запаздывала.
    this.#minCutoff = 8 * Math.pow(0.06, clamped) + 0.35;
    this.#beta = 0.008 + clamped * 0.05;
  }

  /** Отфильтровать значение. `timeSeconds` — монотонное время. */
  filter(value: number, timeSeconds: number): number {
    if (!this.#x.initialized) {
      this.#lastTime = timeSeconds;
      this.#lastRaw = value;
      return this.#x.filter(value, 1);
    }
    const dt = Math.max(1e-4, Math.min(0.25, timeSeconds - this.#lastTime));
    this.#lastTime = timeSeconds;

    const rawDerivative = (value - this.#lastRaw) / dt;
    this.#lastRaw = value;
    const derivative = this.#dx.filter(rawDerivative, alpha(this.#dCutoff, dt));

    const cutoff = this.#minCutoff + this.#beta * Math.abs(derivative);
    return this.#x.filter(value, alpha(cutoff, dt));
  }

  reset(): void {
    this.#x.reset();
    this.#dx.reset();
  }
}

/** Пара фильтров для 2D-точки. */
export class PointFilter {
  #x: OneEuroFilter;
  #y: OneEuroFilter;

  constructor(smoothing = 0.55) {
    this.#x = new OneEuroFilter();
    this.#y = new OneEuroFilter();
    this.setSmoothing(smoothing);
  }

  setSmoothing(smoothing: number): void {
    this.#x.setSmoothing(smoothing);
    this.#y.setSmoothing(smoothing);
  }

  filter(x: number, y: number, timeSeconds: number): { x: number; y: number } {
    return { x: this.#x.filter(x, timeSeconds), y: this.#y.filter(y, timeSeconds) };
  }

  reset(): void {
    this.#x.reset();
    this.#y.reset();
  }
}

/** Скалярный фильтр (щелчок, давления и т.п.) с простым экспоненциальным сглаживанием. */
export class ScalarSmoother {
  #value = 0;
  #initialized = false;
  #response = 0.35;

  constructor(response = 0.35) {
    this.#response = response;
  }

  push(value: number, dt: number): number {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#value = value;
      return value;
    }
    const k = 1 - Math.pow(1 - this.#response, Math.max(dt, 1e-3) * 60);
    this.#value += (value - this.#value) * k;
    return this.#value;
  }

  get value(): number {
    return this.#value;
  }

  reset(): void {
    this.#initialized = false;
    this.#value = 0;
  }
}
