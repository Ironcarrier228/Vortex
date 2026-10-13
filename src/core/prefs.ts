/**
 * Настройки приложения: значения по умолчанию, сохранение в localStorage,
 * подписка на изменения (движок и сцены реактивно перестраиваются).
 */

export type SceneId = 'audio' | 'network' | 'disk';
export type AudioModeId = 'spectrum' | 'particles' | 'tunnel' | 'sphere';
export type AudioSourceId = 'system' | 'mic' | 'none';
export type FpsCap = 'unlimited' | '60' | '30';

export interface Prefs {
  scene: SceneId;
  hudVisible: boolean;
  paused: boolean;

  bloomEnabled: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;

  exposure: number;
  contrast: number;
  saturation: number;
  chroma: number;
  vignette: number;
  grain: number;

  adaptiveQuality: boolean;
  fpsCap: FpsCap;
  pauseWhenHidden: boolean;

  audioMode: AudioModeId;
  audioSource: AudioSourceId;
  audioAutoStart: boolean;

  networkGlobe: boolean;
  networkLabels: boolean;
  networkPollMs: number;

  diskColorBy: 'category' | 'depth' | 'age';

  /* ── Управление жестами (веб-камера) ── */
  /** Распознавание рук включено (камера). */
  handEnabled: boolean;
  /** Синтетическая рука вместо камеры: демонстрация и отладка жестов. */
  handDemo: boolean;
  /** Зеркалить по горизонтали: движение руки «как в зеркале». */
  handMirror: boolean;
  /** Рисовать скелет кисти и курсор. */
  handShowSkeleton: boolean;
  /** Показывать превью камеры в углу. */
  handShowPreview: boolean;
  /** Усиление движения: рукой в воздухе можно управлять всем экраном. */
  handSensitivity: number;
  /** Сглаживание курсора 0…0.95 (One Euro Filter). */
  handSmoothing: number;
  /**
   * Пауза жестом открытой ладони. По умолчанию выключена: срабатывала случайно,
   * когда рука просто висела раскрытой (пользователь: «на паузу ставится иногда»).
   */
  handPauseGesture: boolean;
  /** Кулак «вернуть раскладку» — тоже выключен: сбрасывал расстановку узлов случайно. */
  handFistReset: boolean;
  /** Свайп ладонью переключает сцены. Выключен: сцены переключаются вкладками и клавишами 1–3. */
  handSwipeScenes: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  scene: 'audio',
  hudVisible: true,
  paused: false,

  bloomEnabled: true,
  bloomStrength: 0.72,
  bloomRadius: 0.55,
  bloomThreshold: 0.22,

  exposure: 1.08,
  contrast: 1.04,
  saturation: 1.12,
  chroma: 0.35,
  vignette: 0.42,
  grain: 0.05,

  adaptiveQuality: true,
  fpsCap: '60',
  pauseWhenHidden: true,

  audioMode: 'spectrum',
  audioSource: 'system',
  audioAutoStart: true,

  networkGlobe: false,
  networkLabels: true,
  networkPollMs: 2000,

  diskColorBy: 'category',

  handEnabled: false, // камера включается осознанно: либо кнопкой, либо ?hand=1 в адресе
  handDemo: false,
  handMirror: true,
  handShowSkeleton: true,
  handShowPreview: false,
  handSensitivity: 1.2,
  handSmoothing: 0.55,
  handPauseGesture: false,
  handFistReset: false,
  handSwipeScenes: false,
};

const STORAGE_KEY = 'vortex.prefs.v1';

type Listener = (prefs: Prefs, changed: (keyof Prefs)[]) => void;

export class PrefsStore {
  #prefs: Prefs;
  #listeners = new Set<Listener>();

  constructor() {
    this.#prefs = { ...DEFAULT_PREFS, ...this.#load() };
  }

  #load(): Partial<Prefs> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  get(): Prefs {
    return this.#prefs;
  }

  /** Обновить часть настроек. Возвращает список фактически изменившихся ключей. */
  set(patch: Partial<Prefs>): (keyof Prefs)[] {
    const changed: (keyof Prefs)[] = [];
    for (const key of Object.keys(patch) as (keyof Prefs)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (this.#prefs[key] !== value) {
        // Присваивание через индекс безопасно: тип значения совпадает с ключом патча.
        (this.#prefs as unknown as Record<string, unknown>)[key] = value;
        changed.push(key);
      }
    }
    if (changed.length > 0) {
      this.#persist();
      for (const listener of this.#listeners) listener(this.#prefs, changed);
    }
    return changed;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    this.#prefs = { ...DEFAULT_PREFS };
    this.#persist();
    for (const listener of this.#listeners) listener(this.#prefs, Object.keys(this.#prefs) as (keyof Prefs)[]);
  }

  #persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#prefs));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }
}
