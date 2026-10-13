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
 *  • **30 FPS распознавания** при 60 FPS рендера: `requestVideoFrameCallback`, если есть;
 *    если кадры видео почему-то не доходят, сторож сам переводит цикл на `requestAnimationFrame`
 *    и говорит об этом в статусе — «жесты не работают» не должно оставаться без объяснения.
 *  • **Честная диагностика кадра.** Раз в секунду считаем среднюю яркость кадра и число
 *    распознаваний: «кадр почти чёрный», «камера не отдаёт кадры» и «кисть не найдена» — это
 *    разные проблемы, и пользователь должен видеть, какая именно у него.
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

/**
 * Порог уверенности для поиска кисти (обнаружение, присутствие, трекинг).
 * Ниже дефолтных 0.5: далёкая или плохо освещённая рука иначе не находится вовсе.
 */
const HAND_CONFIDENCE = 0.35;


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
  /** Как часто реально приходят распознавания и сколько кадров обработано всего. */
  #lastDetectWall = 0;
  #frames = 0;
  /** Средняя яркость кадра 0..255 (замер раз в секунду) и когда её мерили. */
  #darkness = -1;
  #lastBrightnessAt = 0;
  #brightness: HTMLCanvasElement | null = null;
  /** Какой именно камерой снимаем: у ноутбуков их часто две, и «не та» ломает всё. */
  #deviceId: string;
  /** Режим цикла: кадры видео (rVFC) или опрос по кадрам рендера (rAF). */
  #loop: 'video' | 'raf' = 'video';
  #watchdog = 0;
  /** Сколько секунд камера молчит (readyState < 2) — для честной ошибки. */
  #silentSince = 0;

  constructor(options: { deviceId?: string } = {}) {
    this.#deviceId = options.deviceId ?? '';
  }

  /** Видео нужно оверлею для превью камеры. */
  get videoElement(): HTMLVideoElement | null {
    return this.#video;
  }

  /**
   * Сменить камеру на ходу (в настройках можно выбрать устройство). Модель не пересоздаём:
   * меняется только поток — так переключение мгновенное.
   */
  async setDeviceId(deviceId: string): Promise<void> {
    if (deviceId === this.#deviceId) return;
    this.#deviceId = deviceId;
    if (!this.#running) return;
    try {
      const video = await this.#openCamera();
      if (!this.#stopped) this.#scheduleLoop();
      this.#setStatus({
        ...this.status,
        phase: 'running',
        message: 'распознавание идёт',
        resolution: `${video.videoWidth}×${video.videoHeight}`,
      });
    } catch (err) {
      this.#setStatus({ ...this.status, phase: 'error', message: describeError(err) });
    }
  }

  /** Число обработанных кадров — по нему пользователь видит, что распознавание идёт. */
  get frames(): number {
    return this.#frames;
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
        device: this.#deviceLabel(),
        fps: 0,
      });
      this.#lastDetectWall = performance.now();
      this.#scheduleLoop();
      this.#startWatchdog();
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
    this.#lastDetectWall = 0;
    this.#frames = 0;
    this.#darkness = -1;
    this.#silentSince = 0;
    this.#loop = 'video';
    if (this.#watchdog) {
      window.clearInterval(this.#watchdog);
      this.#watchdog = 0;
    }
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
    // Пороги уверенности снижены с дефолтных 0.5: рука вдали от камеры или в полутени
    // «недобирала» уверенности, и модель молча не находила её вовсе — это выглядело как
    // «жесты включились, а рук нет». Ложные срабатывания гасит калибровка щипка.
    const base = {
      modelAssetBuffer: modelBytes,
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: HAND_CONFIDENCE,
      minHandPresenceConfidence: HAND_CONFIDENCE,
      minTrackingConfidence: HAND_CONFIDENCE,
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
        ...(this.#deviceId ? { deviceId: { exact: this.#deviceId } } : { facingMode: 'user' }),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 60 },
      },
    });
    // Прошлый поток закрываем здесь же: иначе камера остаётся занятой (NotReadableError).
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = stream;

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Видео обязано оставаться «видимым» для браузера: у элементов с opacity: 0 и у
    // выключенных из потока кадров Chromium не считает кадры показанными, а тогда
    // `requestVideoFrameCallback` не вызывается вовсе — распознавание молча стоит,
    // а пользователь видит «жесты · рук: 0». Поэтому элемент крошечный, но настоящий.
    video.style.position = 'fixed';
    video.style.left = '0';
    video.style.top = '0';
    video.style.width = '4px';
    video.style.height = '4px';
    video.style.opacity = '0.02';
    video.style.pointerEvents = 'none';
    video.style.zIndex = '-1';
    const stale = this.#video;
    this.#video = video;
    document.body.appendChild(video);
    stale?.remove();
    await video.play();
    // Ждём метаданные: без них videoWidth = 0, и модель получит пустой кадр.
    this.#silentSince = performance.now();
    await new Promise<void>((resolve) => {
      if (video.videoWidth > 0) return resolve();
      const timer = window.setTimeout(() => resolve(), 4000);
      video.addEventListener('loadeddata', () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
    return video;
  }

  /**
   * Сторож распознавания. Раз в секунду проверяет, что кадры вообще доходят, и чинит
   * самые частые причины «жесты включились, а рук нет»:
   *  • камера молчит (readyState < 2 дольше 3 с) — честная ошибка вместо тишины;
   *  • `requestVideoFrameCallback` не срабатывает — переходим на опрос кадрами рендера.
   */
  #startWatchdog(): void {
    if (this.#watchdog) return;
    this.#watchdog = window.setInterval(() => this.#checkHealth(), 1000);
  }

  #checkHealth(): void {
    const video = this.#video;
    if (!this.#running || !video) return;

    if (video.readyState < 2 || video.videoWidth === 0) {
      if (this.#silentSince === 0) this.#silentSince = performance.now();
      if (performance.now() - this.#silentSince > 3000) {
        this.#setStatus({
          ...this.status,
          phase: 'error',
          message: 'камера не отдаёт кадры (поток открыт, видео пустое) — выберите другое устройство в настройках',
        });
      }
      return;
    }
    this.#silentSince = 0;
    // Камера ожила (или её выбрали заново) — возвращаем рабочий статус вместо ошибки.
    if (this.status.phase === 'error') {
      this.#setStatus({
        ...this.status,
        phase: 'running',
        message: 'распознавание идёт',
        device: this.#deviceLabel(),
        resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : this.status.resolution,
      });
    }

    // Кадры видит браузер, но распознавания нет дольше полутора секунд — цикл замер.
    const idle = performance.now() - this.#lastDetectWall;
    if (idle > 1500 && !this.#stopped) {
      if (this.#loop === 'video') {
        console.warn('[gesture] кадры видео не приходят — переключаюсь на опрос через requestAnimationFrame');
        this.#loop = 'raf';
        this.#setStatus({ ...this.status, phase: 'running', message: 'распознавание идёт (опрос кадров)' });
      }
      this.#scheduleLoop();
    }
  }

  /** Короткая подпись устройства: в HUD видно, с какой именно камеры идёт картинка. */
  #deviceLabel(): string {
    const track = this.#stream?.getVideoTracks()[0];
    if (!track) return '';
    const label = track.label || 'камера';
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : undefined;
    const size = settings?.width && settings?.height ? ` ${settings.width}×${settings.height}` : '';
    // Метка камеры бывает длинной («HD WebCam (1234:5678)») — оставляем разумный хвост.
    return `${label.length > 34 ? `${label.slice(0, 33)}…` : label}${size}`;
  }

  /** Цикл распознавания: `requestVideoFrameCallback` экономит кадры, где видео не обновилось. */
  #scheduleLoop(): void {
    const video = this.#video as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
    }) | null;
    if (!video || !this.#running) return;

    if (this.#loop === 'video' && typeof video.requestVideoFrameCallback === 'function') {
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

    this.#lastDetectWall = performance.now();
    this.#frames++;
    this.#measureFrame();

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

    // Статус обновляем раз в секунду: HUD показывает частоту, разрешение, число кадров
    // и яркость — по ним сразу видно, работает ли камера и попадает ли в кадр свет.
    if (Math.round(this.#fpsEma) !== Math.round(this.status.fps ?? -1) || this.#frames % 30 === 1) {
      this.#setStatus({
        ...this.status,
        phase: 'running',
        fps: this.#fpsEma,
        frames: this.#frames,
        darkness: this.#darkness >= 0 ? this.#darkness : undefined,
        resolution: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : this.status.resolution,
        device: this.status.device ?? this.#deviceLabel(),
      });
    }
  }

  /**
   * Средняя яркость кадра. Нужна, чтобы отличать «камера смотрит в стену/закрыта шторкой»
   * (почти чёрный кадр — модель гарантированно ничего не найдёт) от «рука вне кадра».
   * Замер дешёвый: 32×24 пикселя раз в секунду.
   */
  #measureFrame(): void {
    const video = this.#video;
    if (!video || video.videoWidth === 0) return;
    const now = performance.now();
    if (now - this.#lastBrightnessAt < 1000) return;
    this.#lastBrightnessAt = now;
    try {
      const canvas = this.#brightness ?? (this.#brightness = document.createElement('canvas'));
      canvas.width = 32;
      canvas.height = 24;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, 32, 24);
      const data = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      }
      this.#darkness = sum / (data.length / 4);
    } catch {
      // getImageData может запретиться (tainted canvas) — тогда просто не показываем яркость.
      this.#darkness = -1;
    }
  }
}

/**
 * Список камер для настроек. Метки доступны только после выдачи разрешения —
 * поэтому вызываем это, когда распознавание уже запущено.
 */
export async function listCameras(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({ id: device.deviceId, label: device.label || `камера ${index + 1}` }));
  } catch {
    return [];
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
