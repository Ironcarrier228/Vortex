/**
 * Оверлей жестов: скелет кисти, курсор, индикаторы жестов и превью камеры.
 *
 * Рисуется на отдельном 2D-канвасе поверх WebGL-сцены, но под HUD (`pointer-events: none`).
 * Задача — чтобы управление рукой было «прозрачным»: видно, что камера тебя видит, где сейчас
 * курсор, сколько осталось до срабатывания жеста и что именно держит сцена.
 */

import { HAND_CONNECTIONS } from './landmarks';
import type { GestureState, HandFrame } from './types';

const COLOR_CYAN = '#22d3ee';
const COLOR_PINK = '#f472b6';
const COLOR_WHITE = '#eaf6ff';

export interface OverlayOptions {
  mirror: boolean;
  showSkeleton: boolean;
  showPreview: boolean;
  /** Функция перевода координат кадра в NDC — та же, что у контроллера (курсор совпадёт со скелетом). */
  mapToNdc: (x: number, y: number) => { x: number; y: number };
  statusText: string;
  handCount: number;
}

export class GestureOverlay {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D | null;
  #frame: HandFrame | null = null;
  #tether: { x: number; y: number } | null = null;
  #ready = false;

  constructor(parent: HTMLElement = document.body) {
    const canvas = document.createElement('canvas');
    canvas.id = 'gesture-overlay';
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:8;display:none;';
    parent.appendChild(canvas);
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.resize();
  }

  get element(): HTMLCanvasElement {
    return this.#canvas;
  }

  setVisible(visible: boolean): void {
    this.#ready = visible;
    this.#canvas.style.display = visible ? 'block' : 'none';
    if (!visible) {
      const ctx = this.#ctx;
      if (ctx) ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    }
  }

  pushFrame(frame: HandFrame): void {
    this.#frame = frame;
  }

  /** Сцена сообщает, к какому объекту «привязана» рука (линия от курсора к узлу). */
  setTether(point: { x: number; y: number } | null): void {
    this.#tether = point;
  }

  /** Видео-кадр для превью (передаётся источником камеры). */
  video: HTMLVideoElement | null = null;

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#canvas.width = Math.floor(window.innerWidth * dpr);
    this.#canvas.height = Math.floor(window.innerHeight * dpr);
    this.#ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Основной проход отрисовки. Вызывается каждый кадр движка, пока жесты включены. */
  render(state: GestureState, options: OverlayOptions): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#ready) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    if (options.showPreview) this.#drawPreview(ctx, width, height);

    if (options.showSkeleton && this.#frame) {
      for (let index = 0; index < this.#frame.hands.length; index++) {
        const hand = this.#frame.hands[index];
        const isPrimary = index === 0;
        this.#drawSkeleton(ctx, hand.landmarks, options, isPrimary);
      }
    }

    if (state.secondaryCursor.active) {
      this.#drawSecondary(ctx, state);
    }

    if (state.cursor.active) {
      this.#drawCursor(ctx, state, options);
    }

    if (state.cursor.active && this.#tether) {
      this.#drawTether(ctx, state, options);
    }

    if (state.twoHand.active) {
      this.#drawTwoHand(ctx, state);
    }

    this.#drawBadge(ctx, state, options);
  }

  /* ─────────────────────────── Отрисовка ─────────────────────────── */

  #toScreen(x: number, y: number, options: OverlayOptions): { x: number; y: number } {
    const ndc = options.mapToNdc(x, y);
    return { x: (ndc.x * 0.5 + 0.5) * window.innerWidth, y: (-ndc.y * 0.5 + 0.5) * window.innerHeight };
  }

  #drawSkeleton(
    ctx: CanvasRenderingContext2D,
    landmarks: { x: number; y: number; z: number }[],
    options: OverlayOptions,
    primary: boolean,
  ): void {
    if (landmarks.length < 21) return;
    const points = landmarks.map((point) => this.#toScreen(point.x, point.y, options));

    ctx.save();
    ctx.lineCap = 'round';

    // Кости: градиент от запястья (циан) к кончикам (розовый) — читается направление кисти.
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = points[from];
      const b = points[to];
      const depth = (from + to) / 40;
      ctx.strokeStyle = primary
        ? mix(COLOR_CYAN, COLOR_PINK, depth)
        : 'rgba(167, 139, 250, 0.55)';
      ctx.lineWidth = primary ? 2.6 : 1.8;
      ctx.shadowColor = primary ? 'rgba(34, 211, 238, 0.75)' : 'rgba(167, 139, 250, 0.5)';
      ctx.shadowBlur = primary ? 14 : 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Суставы.
    ctx.shadowBlur = 10;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      const isTip = index === 4 || index === 8 || index === 12 || index === 16 || index === 20;
      ctx.fillStyle = isTip ? COLOR_WHITE : 'rgba(180, 240, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(point.x, point.y, isTip ? 3.4 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  #drawCursor(ctx: CanvasRenderingContext2D, state: GestureState, options: OverlayOptions): void {
    const { screenX, screenY } = state.cursor;
    const pinch = state.pinch;
    const radius = 17;
    const strength = pinch.strength;

    ctx.save();
    ctx.translate(screenX, screenY);

    // Внешнее кольцо: заполняется по мере сжатия щипка.
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = `rgba(34, 211, 238, ${0.25 + strength * 0.5})`;
    ctx.shadowColor = 'rgba(34, 211, 238, 0.8)';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (strength > 0.01) {
      ctx.strokeStyle = pinch.active ? COLOR_PINK : COLOR_CYAN;
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * strength);
      ctx.stroke();
    }

    // Захват: кольцо «защёлкивается», появляются деления.
    if (state.grabbed) {
      ctx.shadowColor = 'rgba(244, 114, 182, 0.9)';
      ctx.strokeStyle = COLOR_PINK;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 4.5, 0, Math.PI * 2);
      ctx.stroke();
      const spin = performance.now() / 600;
      ctx.lineWidth = 2;
      for (let tick = 0; tick < 4; tick++) {
        const angle = spin + (tick * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * (radius - 1), Math.sin(angle) * (radius - 1));
        ctx.lineTo(Math.cos(angle) * (radius + 4), Math.sin(angle) * (radius + 4));
        ctx.stroke();
      }
    }

    // Точка курсора.
    ctx.shadowBlur = 12;
    ctx.fillStyle = pinch.active ? COLOR_PINK : COLOR_WHITE;
    ctx.beginPath();
    ctx.arc(0, 0, pinch.active ? 5.6 : 4.2, 0, Math.PI * 2);
    ctx.fill();

    // Кольцо удержания командного жеста («пауза», «сброс», «действие»).
    if (state.holdLabel && state.holdProgress > 0.01) {
      ctx.shadowColor = 'rgba(251, 191, 36, 0.9)';
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * state.holdProgress);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(251, 191, 36, 0.95)';
      ctx.font = '600 11px var(--font-mono, monospace)';
      ctx.textAlign = 'center';
      ctx.fillText(`${state.holdLabel} ${Math.round(state.holdProgress * 100)}%`, 0, -radius - 18);
    }

    // Подпись позы рядом с курсором — чтобы пользователь понимал, что видит модель.
    if (!state.holdLabel && (options.showSkeleton || options.showPreview)) {
      const label =
        state.pose === 'pinch'
          ? 'щипок'
          : state.pose === 'open'
            ? 'ладонь'
            : state.pose === 'fist'
              ? 'кулак'
              : state.pose === 'thumbsUp'
                ? 'класс'
                : state.pose === 'point'
                  ? 'указание'
                  : '';
      if (label) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(234, 246, 255, 0.85)';
        ctx.font = '11px var(--font-mono, monospace)';
        ctx.textAlign = 'left';
        ctx.fillText(label, 24, 4);
      }
    }

    ctx.restore();
  }

  #drawSecondary(ctx: CanvasRenderingContext2D, state: GestureState): void {
    const { screenX, screenY } = state.secondaryCursor;
    ctx.save();
    ctx.translate(screenX, screenY);
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.75)';
    ctx.shadowColor = 'rgba(167, 139, 250, 0.7)';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  #drawTwoHand(ctx: CanvasRenderingContext2D, state: GestureState): void {
    const a = { x: state.cursor.screenX, y: state.cursor.screenY };
    const b = { x: state.secondaryCursor.screenX, y: state.secondaryCursor.screenY };
    ctx.save();
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(10, 16, 28, 0.8)';
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.6)';
    const label = `×${state.twoHand.scale.toFixed(2)}`;
    ctx.font = '11px var(--font-mono, monospace)';
    const textWidth = ctx.measureText(label).width;
    ctx.beginPath();
    ctx.roundRect(midX - textWidth / 2 - 8, midY - 11, textWidth + 16, 22, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d9e7ff';
    ctx.textAlign = 'center';
    ctx.fillText(label, midX, midY + 4);
    ctx.restore();
  }

  /** Линия «рука ↔ объект», когда сцена держит узел/здание. */
  #drawTether(ctx: CanvasRenderingContext2D, state: GestureState, options: OverlayOptions): void {
    const tether = this.#tether;
    if (!tether) return;
    ctx.save();
    const gradient = ctx.createLinearGradient(state.cursor.screenX, state.cursor.screenY, tether.x, tether.y);
    gradient.addColorStop(0, 'rgba(244, 114, 182, 0.9)');
    gradient.addColorStop(1, 'rgba(34, 211, 238, 0.25)');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = 'rgba(244, 114, 182, 0.7)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(state.cursor.screenX, state.cursor.screenY);
    ctx.lineTo(tether.x, tether.y);
    ctx.stroke();

    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(234, 246, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(tether.x, tether.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    void options;
  }

  #drawPreview(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const video = this.video;
    if (!video || video.readyState < 2) return;

    const boxWidth = 224;
    const boxHeight = boxWidth * 0.75;
    const x = 16;
    const y = height - boxHeight - 60;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 12);
    ctx.clip();

    // Зеркалим картинку: так рука в превью совпадает с тем, что видит пользователь.
    ctx.translate(x + boxWidth, y);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(video, 0, 0, boxWidth, boxHeight);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 12);
    ctx.stroke();
    ctx.restore();
    void width;
  }

  /** Компактная строка статуса рядом с превью: модель, FPS, руки. */
  #drawBadge(ctx: CanvasRenderingContext2D, state: GestureState, options: OverlayOptions): void {
    const text = `${options.statusText} · рук: ${options.handCount}`;
    ctx.save();
    ctx.font = '11px var(--font-mono, monospace)';
    const textWidth = ctx.measureText(text).width;
    const x = 16;
    const y = options.showPreview ? window.innerHeight - 60 - 244 : window.innerHeight - 60 - 30;

    ctx.fillStyle = 'rgba(10, 16, 28, 0.68)';
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.28)';
    ctx.beginPath();
    ctx.roundRect(x, y, textWidth + 20, 24, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = state.cursor.active ? '#9be9ff' : 'rgba(160, 180, 200, 0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 10, y + 16);
    ctx.restore();
  }

  dispose(): void {
    this.#canvas.remove();
    this.#ctx = null;
    this.#frame = null;
  }
}

/** Линейная интерполяция двух hex-цветов (для градиента костей). */
function mix(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const clamped = Math.min(1, Math.max(0, t));
  const r = Math.round(r1 + (r2 - r1) * clamped);
  const g = Math.round(g1 + (g2 - g1) * clamped);
  const b = Math.round(b1 + (b2 - b1) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}
