/**
 * Источник рук №1: веб-камера + MediaPipe Hand Landmarker (WebAssembly/WebGL).
 *
 * Что здесь важного:
 *  • **Без сети по возможности.** WASM-файлы кладёт рядом `npm run sync:mediapipe`
 *    (из node_modules), модель — `npm run fetch:models`; если локальной модели нет,
 *    пробуем CDN MediaPipe, и только потом отдаём понятную ошибку.
 *  • **Проверка модели по сигнатуре ZIP.** `.task` — это zip, поэтому HTML-заглушка
 *    от dev-сервера не пролезет: лучше явная ошибка, чем «магическая» поломка внутри WASM.
 *  • **GPU, иначе CPU.** Делегат GPU требует свой canvas для WebGL-контекста; если он
 *    не поднялся (частая ситуация на старых драйверах), спокойно откатываемся на CPU.
 *  • **30 FPS распознавания** при 60 FPS рендера: `requestVideoFrameCallback`, если есть.
 *  • **Опциональность.** Сама библиотека MediaPipe грузится в рантайме (локальная копия →
 *    CDN), поэтому приложение собирается и работает и без неё: жесты просто покажут
 *    понятную ошибку в статусе, а не уронят dev-сервер или сборку.
 */

import { loadMediaPipe, type MpFileset, type MpLandmarker } from './mediapipe';
import { MODEL_LOCAL, MODEL_SOURCES, looksLikeTaskFile } from './modelFile';
import type { HandFrame, HandObservation, HandSource, SourceStatus } from './types';

const WASM_LOCAL = '/mediapipe/wasm';
/** Запасной источник WASM. Версия должна совпадать с зависимостью @mediapipe/tasks-vision. */
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';


export class CameraHandSource implements HandSource {
  readonly kind = 'camera' as const;
  status: SourceStatus = { phase: 'off' };

  #frameListeners = new Set<(frame: HandFrame) => void>();
  #statusListeners = new Set<(status: SourceStatus) => void>();

  #landmarker: MpLandmarker | null = null;
  #video: HTMLVideoElement | null = null;
  #stream: MediaStream | null = null;
  #gpuCanvas: HTMLCanvasElement | null = null;
  #running = false;
  #stopped = true;
  #lastTimestamp = -1;
  #fpsEma = 0;
  #lastFrameAt = 0;
  #videoCallbackId = 0;
  /** Минимальный интервал между распознаваниями (мс) — адаптивная экономия GPU. */
  #minIntervalMs = 0;
  #lastDetectAt = 0;

  /** Видео нужно оверлею для превью камеры. */
  get videoElement(): HTMLVideoElement | null {
    return this.#video;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = false;

    try {
      const fileset = await this.#loadFileset();
      if (this.#stopped) return;

      this.#setStatus({ phase: 'loading-model', message: 'загружаю модель', delegate: this.status.delegate });
      const modelBytes = await this.#loadModelBytes();
      if (this.#stopped) return;

      this.#setStatus({ phase: 'starting-camera', message: 'запрашиваю камеру' });
      const video = await this.#openCamera();
      if (this.#stopped) return;

      this.#setStatus({ phase: 'starting-camera', message: 'инициализирую модель' });
      this.#landmarker = await this.#createLandmarker(fileset, modelBytes);
      if (this.#stopped) return;

      this.#setStatus({
        phase: 'running',
        message: 'распознавание идёт',
        delegate: this.#landmarker ? this.status.delegate : undefined,
        resolution: `${video.videoWidth}×${video.videoHeight}`,
        fps: 0,
      });
      this.#scheduleLoop();
    } catch (err) {
      this.#running = false;
      this.#setStatus({ phase: 'error', message: describeError(err) });
      this.#teardownHardware();
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#running = false;
    this.#teardownHardware();
    this.#setStatus({ phase: 'off' });
  }

  setMaxHz(hz: number): void {
    this.#minIntervalMs = hz > 0 ? 1000 / hz : 0;
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

  #teardownHardware(): void {
    this.#lastDetectAt = 0;
    if (this.#videoCallbackId && this.#video) {
      const video = this.#video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void;
      };
      video.cancelVideoFrameCallback?.(this.#videoCallbackId);
      this.#videoCallbackId = 0;
    }
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    if (this.#video) {
      this.#video.srcObject = null;
      this.#video.remove();
      this.#video = null;
    }
    this.#landmarker?.close();
    this.#landmarker = null;
    this.#gpuCanvas?.remove();
    this.#gpuCanvas = null;
    this.#lastTimestamp = -1;
  }

  /** WASM-набор: сначала локальная копия, затем CDN. */
  async #loadFileset(): Promise<MpFileset> {
    this.#setStatus({ phase: 'loading-wasm', message: 'загружаю WASM' });
    const { FilesetResolver } = await loadMediaPipe();
    try {
      return await FilesetResolver.forVisionTasks(WASM_LOCAL);
    } catch (err) {
      console.warn('[gesture] локальный WASM недоступен, беру CDN:', err);
      this.#setStatus({ phase: 'loading-wasm', message: 'WASM с CDN' });
      return await FilesetResolver.forVisionTasks(WASM_CDN);
    }
  }

  /**
   * Модель: локальный файл (офлайн) → официальный CDN → зеркала на CDN npm.
   * Формат проверяем терпимо (см. `modelFile.ts`): у настоящей модели перед ZIP-сигнатурой
   * стоят два нулевых байта, поэтому строгая проверка «PK» в начале отвергала валидный файл.
   */
  async #loadModelBytes(): Promise<Uint8Array> {
    const failures: string[] = [];
    for (const url of MODEL_SOURCES) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!looksLikeTaskFile(bytes)) {
          console.warn(`[gesture] ${url} не похож на модель hand_landmarker.task (${bytes.length} байт)`);
          failures.push(`${url}: не контейнер .task (${bytes.length} байт)`);
          continue;
        }
        this.status = { ...this.status, modelSource: url === MODEL_LOCAL ? 'локальный файл' : url };
        return bytes;
      } catch (err) {
        console.warn(`[gesture] модель недоступна по ${url}:`, err);
        failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(
      `модель hand_landmarker.task не найдена (проверено ${failures.length} адресов). ` +
        'Положите файл в public/models/ командой `npm run fetch:models` — ' +
        'или включите «Демо-руку», она работает без модели и камеры',
    );
  }

  async #createLandmarker(fileset: MpFileset, modelBytes: Uint8Array): Promise<MpLandmarker> {
    const { HandLandmarker } = await loadMediaPipe();
    const base = {
      modelAssetBuffer: modelBytes,
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };

    // Двух рук достаточно для зума/поворота; три и больше только путают жесты.
    try {
      const gpuCanvas = document.createElement('canvas');
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetBuffer: modelBytes, delegate: 'GPU' },
        canvas: gpuCanvas,
      });
      this.#gpuCanvas = gpuCanvas;
      this.status = { ...this.status, delegate: 'GPU' };
      return landmarker;
    } catch (err) {
      console.warn('[gesture] GPU-делегат недоступен, перехожу на CPU:', err);
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetBuffer: modelBytes, delegate: 'CPU' },
      });
      this.status = { ...this.status, delegate: 'CPU' };
      return landmarker;
    }
  }

  async #openCamera(): Promise<HTMLVideoElement> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('браузерное окружение не даёт доступ к камере (getUserMedia)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
      },
    });
    this.#stream = stream;

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Видео живёт вне DOM: пиксели нужны только модели и превью в оверлее.
    video.style.position = 'fixed';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.style.width = '2px';
    video.style.height = '2px';
    document.body.appendChild(video);
    await video.play();
    this.#video = video;
    return video;
  }

  /** Цикл распознавания: `requestVideoFrameCallback` экономит кадры, где видео не обновилось. */
  #scheduleLoop(): void {
    const video = this.#video as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
    }) | null;
    if (!video || !this.#running) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
      this.#videoCallbackId = video.requestVideoFrameCallback(() => {
        this.#detect();
        this.#scheduleLoop();
      });
    } else {
      requestAnimationFrame(() => {
        this.#detect();
        this.#scheduleLoop();
      });
    }
  }

  #detect(): void {
    const landmarker = this.#landmarker;
    const video = this.#video;
    if (!landmarker || !video || !this.#running || video.readyState < 2) return;

    const timestamp = performance.now();
    // Экономный режим: на слабом GPU пропускаем часть кадров видео, чтобы не душить рендер.
    if (this.#minIntervalMs > 0 && timestamp - this.#lastDetectAt < this.#minIntervalMs) return;
    this.#lastDetectAt = timestamp;
    // MediaPipe требует строго возрастающую метку времени.
    if (timestamp <= this.#lastTimestamp) return;
    this.#lastTimestamp = timestamp;

    const started = timestamp;
    let result;
    try {
      result = landmarker.detectForVideo(video, timestamp);
    } catch (err) {
      console.warn('[gesture] ошибка распознавания:', err);
      return;
    }

    const inferenceMs = performance.now() - started;
    const instantFps = this.#lastFrameAt > 0 ? 1000 / Math.max(1, timestamp - this.#lastFrameAt) : 30;
    this.#lastFrameAt = timestamp;
    this.#fpsEma = this.#fpsEma === 0 ? instantFps : this.#fpsEma * 0.9 + instantFps * 0.1;

    const hands: HandObservation[] = result.landmarks.map((points, index) => ({
      landmarks: points.map((point) => ({ x: point.x, y: point.y, z: point.z })),
      handedness: (result.handedness[index]?.[0]?.categoryName as HandObservation['handedness']) ?? 'Unknown',
      score: result.handedness[index]?.[0]?.score ?? 0.9,
    }));

    const frame: HandFrame = { hands, timestampMs: timestamp, inferenceMs };
    for (const listener of this.#frameListeners) listener(frame);

    if (Math.round(this.#fpsEma) !== Math.round(this.status.fps ?? -1)) {
      this.#setStatus({ ...this.status, phase: 'running', fps: this.#fpsEma });
    }
  }
}

/** Понятные сообщения вместо «NotAllowedError». */
function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'доступ к камере запрещён — разрешите его в настройках Windows/браузера';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'камера не найдена';
      case 'NotReadableError':
        return 'камера занята другим приложением';
      case 'OverconstrainedError':
        return 'камера не поддерживает нужный формат';
      default:
        return `ошибка камеры: ${err.name}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
