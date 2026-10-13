/**
 * Подключение MediaPipe Tasks Vision — ровно то, что использует VORTEX.
 *
 * Почему библиотека грузится тегом `<script>`, а не импортом из npm:
 *  • распознавание рук — **опция**: если библиотеки нет (не выполнен `npm install`, нет интернета),
 *    приложение обязано собираться и работать как обычно, а жесты — показать понятную ошибку;
 *  • файлы из `public/` нельзя импортировать из кода (Vite прямо это запрещает), а импорт пакета
 *    делает зависимость жёсткой на этапе сборки — dev-сервер падал бы без `npm install`;
 *  • официальный бандл `vision_bundle.js` — это IIFE, который кладёт всё на глобальный объект
 *    `Vision`, то есть его штатный способ подключения и есть `<script>` (так же делает и CDN).
 *
 * Порядок источников: локальная копия (`npm run sync:mediapipe`) → CDN.
 *
 * Типы ниже — минимум, который нам нужен, сверенный с `vision.d.ts` пакета 1.1.0
 * (полная типизация здесь не нужна: модуль проверяется по форме перед использованием).
 */

/** Точка кисти: координаты нормализованы в 0..1 (y растёт вниз), z — относительная глубина. */
export interface MpLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Категория классификатора (у нас — метка руки «Left»/«Right»). */
export interface MpCategory {
  score: number;
  index: number;
  categoryName: string;
}

/** Результат распознавания кадра. */
export interface MpResult {
  /** `landmarks[рука][21]` — точки кисти. */
  landmarks: MpLandmark[][];
  /** `handedness[рука][0]` — метка руки. В 1.1.0 — основной источник, `handednesses` устарел. */
  handedness: MpCategory[][];
}

export type MpDelegate = 'CPU' | 'GPU';

export interface MpHandLandmarkerOptions {
  baseOptions?: {
    modelAssetPath?: string;
    modelAssetBuffer?: Uint8Array | ReadableStreamDefaultReader;
    delegate?: MpDelegate;
  };
  runningMode?: 'IMAGE' | 'VIDEO';
  numHands?: number;
  minHandDetectionConfidence?: number;
  minHandPresenceConfidence?: number;
  minTrackingConfidence?: number;
  /** Свой canvas нужен делегату GPU для WebGL-контекста. */
  canvas?: HTMLCanvasElement;
}

export interface MpLandmarker {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): MpResult;
  close(): void;
}

/** Набор WASM-файлов, который отдаёт `FilesetResolver`; для нас он непрозрачен. */
export interface MpFileset {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}

export interface MediaPipeModule {
  FilesetResolver: {
    forVisionTasks(basePath?: string, useModule?: boolean): Promise<MpFileset>;
  };
  HandLandmarker: {
    createFromOptions(fileset: MpFileset, options: MpHandLandmarkerOptions): Promise<MpLandmarker>;
  };
}

/** Локальная копия библиотеки: её кладёт `npm run sync:mediapipe`. */
const SCRIPT_LOCAL = '/mediapipe/vision_bundle.js';
/** Запасной источник. Версия обязана совпадать с зависимостью @mediapipe/tasks-vision. */
const SCRIPT_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/vision_bundle.js';

let bundlePromise: Promise<MediaPipeModule> | null = null;

/** Бандл кладёт библиотеку на глобальный объект `Vision`. */
function globalMediaPipe(): unknown {
  return (globalThis as { Vision?: unknown }).Vision;
}

/** Проверяем, что загрузилось именно то, что нужно (dev-сервер умеет отдать HTML-заглушку). */
function looksLikeMediaPipe(module: unknown): module is MediaPipeModule {
  const candidate = module as MediaPipeModule | null;
  return (
    typeof candidate?.HandLandmarker?.createFromOptions === 'function' &&
    typeof candidate?.FilesetResolver?.forVisionTasks === 'function'
  );
}

/** Загрузить классический скрипт (библиотека не модульная — её штатный способ подключения). */
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const selector = `script[data-vortex-mediapipe="${url}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    if (existing) {
      // Уже подключён этим приложением: ждём, если он ещё грузится.
      if (existing.dataset.loaded === '1') resolve();
      else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`скрипт не загрузился: ${url}`)), { once: true });
      }
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.dataset.vortexMediapipe = url;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error(`скрипт не загрузился: ${url}`));
    });
    document.head.appendChild(script);
  });
}

async function loadFromSources(): Promise<MediaPipeModule> {
  for (const url of [SCRIPT_LOCAL, SCRIPT_CDN]) {
    try {
      await loadScript(url);
      const library = globalMediaPipe();
      if (looksLikeMediaPipe(library)) return library;
      console.warn(`[gesture] ${url} загрузился, но библиотека MediaPipe в нём не найдена`);
    } catch (err) {
      console.warn(`[gesture] не удалось подключить MediaPipe из ${url}:`, err);
    }
  }
  throw new Error(
    'библиотека MediaPipe не найдена: выполните npm install и npm run sync:mediapipe ' +
      '(файл public/mediapipe/vision_bundle.js) либо дайте приложению доступ к интернету (CDN)',
  );
}

/**
 * Загрузка библиотеки распознавания: локальная копия, затем CDN. Результат кэшируется;
 * после неудачи кэш сбрасывается, чтобы повторное включение жестов попробовало снова.
 */
export async function loadMediaPipe(): Promise<MediaPipeModule> {
  if (bundlePromise) return bundlePromise;
  bundlePromise = loadFromSources();
  try {
    return await bundlePromise;
  } catch (err) {
    bundlePromise = null;
    throw err;
  }
}
