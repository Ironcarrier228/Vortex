/**
 * Аудиошина: единый источник спектра для сцен (и для второго окна).
 *
 * Два источника данных:
 *  • `system` — WASAPI loopback из Rust (событие `vortex://audio/frame`, 64 полосы в дБ);
 *  • `mic`    — WebAudio AnalyserNode (браузерная отладка без Rust / ручной выбор в HUD).
 *
 * Шина занимается нормализацией, сглаживанием и детекцией ритма, поэтому сцены
 * получают уже «визуальные» значения 0..1 и не знают о происхождении данных.
 */

import { listen } from '../transport';
import type { AudioFrame, AudioInfo } from '../types';

export const BANDS = 64;
export type AudioSourceKind = 'system' | 'mic' | 'none';

/** Приводит дБ к 0..1. Формула совпадает с `db_to_unit` в crates/vortex-core. */
export function dbToUnit(db: number): number {
  return Math.min(1, Math.max(0, (db + 72) / 72));
}

export interface AudioSnapshot {
  bands: Float32Array;
  level: number;
  peak: number;
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  /** Импульс ритма: мгновенно 1, затем спадает. */
  beat: number;
  /** Сколько секунд назад был последний ритм (для анимаций «на удар»). */
  sinceBeat: number;
  source: AudioSourceKind;
  available: boolean;
  device?: string;
  sampleRate?: number;
  reason?: string;
}

export class AudioBus {
  readonly bands = new Float32Array(BANDS);
  readonly snapshot: AudioSnapshot = {
    bands: this.bands,
    level: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
    sinceBeat: 99,
    source: 'none',
    available: false,
  };

  #target = new Float32Array(BANDS);
  #smoothed = new Float32Array(BANDS);
  #targetLevel = 0;
  #stats = { reason: undefined as string | undefined, device: undefined as string | undefined, sampleRate: undefined as number | undefined };
  #energyHistory: number[] = [];
  #historyTime = 0;
  #lastBeatAt = -99;
  #clock = 0;
  #unlistenFrame: (() => void) | null = null;
  #unlistenInfo: (() => void) | null = null;
  #mic: MicSource | null = null;
  #source: AudioSourceKind = 'none';
  #listeners = new Set<(s: AudioSnapshot) => void>();

  constructor() {
    // Подписка на системный захват — включается, когда поток реально пойдёт.
    this.#unlistenInfo = listen<AudioInfo>('vortex://audio/info', (info) => {
      this.#stats.reason = info.reason;
      this.#stats.device = info.device;
      this.#stats.sampleRate = info.sampleRate;
      if (!info.available && this.#source === 'system') {
        this.#source = 'none';
        this.snapshot.source = 'none';
        this.snapshot.available = false;
      }
    });
    this.#unlistenFrame = listen<AudioFrame>('vortex://audio/frame', (frame) => {
      // Первые кадры с системного захвата переключают источник автоматически.
      if (this.#source !== 'system') {
        this.#source = 'system';
        this.snapshot.source = 'system';
        this.snapshot.available = true;
        this.#stopMic();
      }
      const bands = frame.bands;
      const count = Math.min(BANDS, bands.length);
      for (let i = 0; i < count; i++) this.#target[i] = dbToUnit(bands[i]);
      this.#targetLevel = dbToUnit(frame.level);
      this.snapshot.peak = Math.max(this.snapshot.peak * 0.92, dbToUnit(frame.peak));
    });
  }

  /** Подписаться на обновлённые снимки (вызывается раз в кадр движком). */
  subscribe(listener: (snapshot: AudioSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get source(): AudioSourceKind {
    return this.#source;
  }

  get info(): AudioSnapshot {
    return this.snapshot;
  }

  /** Включить захват микрофона (браузерная отладка или ручной выбор в HUD). */
  async useMic(): Promise<void> {
    if (this.#mic) return;
    const mic = new MicSource();
    await mic.start();
    this.#mic = mic;
    this.#source = 'mic';
    this.snapshot.source = 'mic';
    this.snapshot.available = true;
    this.snapshot.reason = 'Микрофон (для отладки)';
    this.snapshot.device = mic.label;
    this.snapshot.sampleRate = mic.sampleRate;
  }

  useSilence(): void {
    this.#stopMic();
    this.#source = 'none';
    this.snapshot.source = 'none';
    this.snapshot.available = false;
    this.snapshot.reason = this.#stats.reason ?? 'Источник не выбран';
  }

  #stopMic(): void {
    this.#mic?.stop();
    this.#mic = null;
  }

  /** Вызывается движком каждый кадр: сглаживание, детекция ритма, рассылка. */
  update(dt: number): void {
    this.#clock += dt;

    if (this.#mic) {
      this.#mic.read(this.#target, this.snapshot.bands);
      this.#targetLevel = 0;
      for (let i = 0; i < BANDS; i++) this.#targetLevel += this.#target[i];
      this.#targetLevel /= BANDS;
    }

    // Асимметричное сглаживание: быстрый подъём, плавный спад (как в аналоговом VU).
    const attack = 1 - Math.pow(0.0009, dt);
    const release = 1 - Math.pow(0.06, dt);
    for (let i = 0; i < BANDS; i++) {
      const target = this.#target[i];
      const current = this.#smoothed[i];
      const k = target > current ? attack : release;
      const next = current + (target - current) * k;
      this.#smoothed[i] = next;
      this.bands[i] = next;
    }

    const bass = mean(this.bands, 0, 8);
    const mid = mean(this.bands, 8, 32);
    const treble = mean(this.bands, 32, BANDS);
    const energy = bass * 0.5 + mid * 0.3 + treble * 0.2;

    this.snapshot.bass = bass;
    this.snapshot.mid = mid;
    this.snapshot.treble = treble;
    this.snapshot.energy = energy;
    this.snapshot.level = this.snapshot.level * 0.8 + this.#targetLevel * 0.2;

    // Детектор ритма: всплеск энергии относительно средней за ~1.5 с.
    this.#historyTime += dt;
    this.#energyHistory.push(energy);
    const historyFrames = Math.max(1, Math.round(1.5 / Math.max(dt, 1 / 120)));
    if (this.#energyHistory.length > historyFrames) this.#energyHistory.shift();
    const average =
      this.#energyHistory.reduce((sum, value) => sum + value, 0) / Math.max(1, this.#energyHistory.length);
    const sinceBeat = this.#clock - this.#lastBeatAt;
    if (energy > average * 1.32 && energy > 0.16 && sinceBeat > 0.19) {
      this.#lastBeatAt = this.#clock;
      this.snapshot.beat = 1;
    } else {
      this.snapshot.beat *= Math.pow(0.02, dt); // быстрый, но плавный спад
    }
    this.snapshot.sinceBeat = this.#clock - this.#lastBeatAt;

    for (const listener of this.#listeners) listener(this.snapshot);
  }

  dispose(): void {
    this.#unlistenFrame?.();
    this.#unlistenInfo?.();
    this.#stopMic();
  }
}

function mean(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i];
  return sum / (to - from);
}

/**
 * Микрофонный источник: лог-разбиение спектра AnalyserNode на те же 64 полосы,
 * что отдаёт Rust. Нужен только для отладки фронтенда в браузере.
 */
class MicSource {
  label = '';
  sampleRate = 0;

  #ctx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #analyser: AnalyserNode | null = null;
  #data: Uint8Array = new Uint8Array(0);
  #edges: number[] = [];

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Микрофон недоступен в этом окружении');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    this.#ctx = ctx;
    this.#stream = stream;
    this.#analyser = analyser;
    this.#data = new Uint8Array(analyser.frequencyBinCount);
    this.label = stream.getAudioTracks()[0]?.label ?? 'Микрофон';
    this.sampleRate = ctx.sampleRate;

    // Границы полос те же, что в Rust: 30 Гц … 16 кГц, геометрическая шкала.
    const low = 30;
    const high = Math.min(16000, ctx.sampleRate / 2 - 200);
    const ratio = Math.pow(high / low, 1 / BANDS);
    this.#edges = Array.from({ length: BANDS + 1 }, (_, i) => low * Math.pow(ratio, i));
  }

  read(target: Float32Array, smooth: Float32Array): void {
    const analyser = this.#analyser;
    if (!analyser) return;
    analyser.getByteFrequencyData(this.#data as Uint8Array<ArrayBuffer>);
    const binHz = this.sampleRate / 2 / this.#data.length;
    for (let band = 0; band < BANDS; band++) {
      const from = Math.max(1, Math.floor(this.#edges[band] / binHz));
      const to = Math.max(from + 1, Math.ceil(this.#edges[band + 1] / binHz));
      let peak = 0;
      for (let bin = from; bin < to && bin < this.#data.length; bin++) {
        peak = Math.max(peak, this.#data[bin]);
      }
      target[band] = peak / 255;
    }
    void smooth;
  }

  stop(): void {
    this.#stream?.getTracks().forEach((track) => track.stop());
    void this.#ctx?.close();
    this.#analyser = null;
    this.#ctx = null;
    this.#stream = null;
  }
}
