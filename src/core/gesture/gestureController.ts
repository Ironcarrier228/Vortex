/**
 * Контроллер жестов: превращает поток кадров кисти (30 Гц) в стабильное состояние (60 Гц).
 *
 * Разделение обязанностей:
 *  • `push(frame)` — вызывается редко (когда пришёл кадр распознавания): только фиксирует
 *    «сырые» данные и классифицирует позу;
 *  • `update(dt)` — вызывается каждый кадр рендера: сглаживание, гистерезис щипка, таймеры
 *    удержаний, инерция. Именно поэтому курсор остаётся плавным при 30 FPS распознавания.
 *
 * Все пороги подобраны по отношениям к размеру кисти, а не в абсолютных пикселях: жест
 * одинаково работает и в 40 см, и в двух метрах от камеры.
 */

import { TypedEmitter } from '../events';
import {
  PINCH_ENTER,
  PINCH_EXIT,
  angleBetween,
  angleDelta,
  classifyPose,
  handScale,
  palmCenter,
  pinchRatio,
} from './landmarks';
import { PointFilter, ScalarSmoother } from './oneEuro';
import type { GestureName, GestureState, HandFrame, HandObservation, HandPose } from './types';

export interface GestureOptions {
  /** Зеркалить по горизонтали (естественно для вебки). */
  mirror: boolean;
  /** Усиление движения: 1 — «как есть», >1 — рукой в воздухе управляем всем экраном. */
  sensitivity: number;
  /** Сглаживание 0…0.95. */
  smoothing: number;
  /** Пауза открытой ладонью. */
  pauseGesture: boolean;
}

/** Сколько держать позу, чтобы сработал командный жест (сек). */
const HOLD_TIMES: Record<'open' | 'fist' | 'thumbsUp', number> = {
  open: 0.85,
  fist: 0.8,
  thumbsUp: 0.7,
};

/** Пауза после срабатывания, чтобы жест не повторялся (сек). */
const HOLD_COOLDOWN = 1.6;
/** Сколько можно не видеть руку, прежде чем считать курсор потерянным (сек). */
const HAND_LOST_TIMEOUT = 0.35;
/** Порог свайпа: скорость ладони в долях кадра в секунду. */
const SWIPE_SPEED = 1.9;
/** Сколько держится «залипание» позы, если классификация на кадр промахнулась (сек). */
const POSE_STICKY = 0.12;

export class GestureController {
  readonly state: GestureState = {
    enabled: false,
    handsCount: 0,
    pose: 'none',
    cursor: { active: false, ndcX: 0, ndcY: 0, screenX: 0, screenY: 0 },
    pinch: { strength: 0, active: false, progress: 0 },
    grabbed: false,
    twoHand: { active: false, scale: 1, twist: 0, centerX: 0, centerY: 0 },
    holdLabel: null,
    holdProgress: 0,
    secondaryCursor: { active: false, ndcX: 0, ndcY: 0, screenX: 0, screenY: 0 },
    secondaryPinch: false,
  };

  #emitter = new TypedEmitter<Record<GestureName | 'hand-lost', GestureName | 'hand-lost'>>();
  #options: GestureOptions;

  #pointFilter = new PointFilter(0.55);
  #pinchFilter = new ScalarSmoother(0.45);
  #secondaryFilter = new PointFilter(0.6);

  #hasFrame = false;
  #lastFrameAt = 0;
  #time = 0;

  // «Сырые» цели, приходящие из кадра распознавания.
  #rawCursor = { x: 0, y: 0 };
  #rawSecondary = { x: 0, y: 0 };
  #rawPinchRatio = 1;
  #rawSecondaryPinchRatio = 1;
  #rawScale: number | null = null;
  #rawPose: HandPose = 'none';
  #poseSince = 0;

  #poseHold = 0;
  #poseHoldTarget: 'open' | 'fist' | 'thumbsUp' | null = null;
  #cooldown = 0;

  #swipeVelocity = 0;
  #lastPalmX = 0;
  #swipeCooldown = 0;

  #twoHandArmed = false;
  #twoHandBaseline = 1;
  #twoHandPrevAngle = 0;
  #twoHandTwist = 0;
  #twoHandScale = 1;

  constructor(options: GestureOptions) {
    this.#options = { ...options };
    this.#pointFilter.setSmoothing(this.#options.smoothing);
  }

  setOptions(options: Partial<GestureOptions>): void {
    this.#options = { ...this.#options, ...options };
    this.#pointFilter.setSmoothing(this.#options.smoothing);
    this.#secondaryFilter.setSmoothing(this.#options.smoothing);
    if (!this.#options.mirror) {
      // Смена зеркальности меняет и смысл «вверх-вниз» относительно руки — просто сбрасываем фильтр.
      this.#pointFilter.reset();
    }
  }

  /** Подписка на конкретный жест. Возвращает функцию отписки. */
  on(name: GestureName | 'hand-lost', listener: (name: GestureName | 'hand-lost') => void): () => void {
    return this.#emitter.on(name, listener);
  }

  /** Отметить, что сцена «взяла» объект (для отрисовки захвата). */
  setGrabbed(grabbed: boolean): void {
    this.state.grabbed = grabbed;
  }

  /** Пришёл кадр распознавания. */
  push(frame: HandFrame): void {
    this.#lastFrameAt = this.#time;
    this.#hasFrame = true;

    const hands = frame.hands;
    this.state.handsCount = hands.length;

    if (hands.length === 0) return;

    // Основная рука: та, что щиплет; иначе — с лучшим скором (обычно ближе к камере).
    let primary: HandObservation = hands[0];
    let secondary: HandObservation | null = hands[1] ?? null;
    for (const hand of hands) {
      if (pinchRatio(hand.landmarks) < PINCH_ENTER && primary !== hand) {
        primary = hand;
        break;
      }
    }
    if (secondary === primary) secondary = hands.find((hand) => hand !== primary) ?? null;

    // Во время щипка берём середину между большим и указательным — точка «захвата» стабильнее.
    const primaryPinch = pinchRatio(primary.landmarks);
    const cursorPoint = this.#cursorPoint(primary.landmarks, primaryPinch < PINCH_EXIT);
    this.#rawCursor = cursorPoint;
    this.#rawPinchRatio = primaryPinch;

    if (secondary) {
      const secondaryPinch = pinchRatio(secondary.landmarks);
      this.#rawSecondary = this.#cursorPoint(secondary.landmarks, secondaryPinch < PINCH_EXIT);
      this.#rawSecondaryPinchRatio = secondaryPinch;
      this.#rawScale = Math.hypot(
        this.#rawCursor.x - this.#rawSecondary.x,
        this.#rawCursor.y - this.#rawSecondary.y,
      );
      this.#rawPose = this.#stickyPose(classifyPose(primary.landmarks, primaryPinch < PINCH_ENTER));
    } else {
      this.#rawSecondaryPinchRatio = 1;
      this.#rawScale = null;
      this.#rawPose = this.#stickyPose(classifyPose(primary.landmarks, primaryPinch < PINCH_ENTER));
    }

    // Ручной масштаб кисти — для отладки и подсказок в HUD.
    this.#handScaleSnapshot = handScale(primary.landmarks);
  }

  #handScaleSnapshot = 1;

  get handScaleSnapshot(): number {
    return this.#handScaleSnapshot;
  }

  /** Шаг на каждый кадр рендера: сглаживание, гистерезис, таймеры удержаний. */
  update(dt: number): void {
    this.#time += dt;
    const now = this.#time;

    const lost = !this.#hasFrame || now - this.#lastFrameAt > HAND_LOST_TIMEOUT;
    if (lost) {
      if (this.state.cursor.active) this.#emitter.emit('hand-lost', 'hand-lost');
      this.state.cursor.active = false;
      this.state.secondaryCursor.active = false;
      this.state.pose = 'none';
      this.state.pinch.active = false;
      this.state.pinch.strength = 0;
      this.state.pinch.progress = 0;
      this.state.grabbed = false;
      this.state.twoHand.active = false;
      this.state.twoHand.twist = 0;
      this.#twoHandArmed = false;
      this.#poseHold = 0;
      this.#poseHoldTarget = null;
      this.state.holdLabel = null;
      this.state.holdProgress = 0;
      this.#pointFilter.reset();
      this.#secondaryFilter.reset();
      return;
    }

    // ── Курсор основной руки.
    const cursorTarget = this.mapToNdc(this.#rawCursor.x, this.#rawCursor.y);
    const smoothed = this.#pointFilter.filter(cursorTarget.x, cursorTarget.y, now);
    this.state.cursor.ndcX = smoothed.x;
    this.state.cursor.ndcY = smoothed.y;
    const viewWidth = (typeof window !== 'undefined' && window.innerWidth) || 1920;
    const viewHeight = (typeof window !== 'undefined' && window.innerHeight) || 1080;
    this.state.cursor.screenX = (smoothed.x * 0.5 + 0.5) * viewWidth;
    this.state.cursor.screenY = (-smoothed.y * 0.5 + 0.5) * viewHeight;
    this.state.cursor.active = true;

    // ── Курсор второй руки (без «активности», если руки нет).
    if (this.#rawScale !== null) {
      const target = this.mapToNdc(this.#rawSecondary.x, this.#rawSecondary.y);
      const second = this.#secondaryFilter.filter(target.x, target.y, now);
      this.state.secondaryCursor.ndcX = second.x;
      this.state.secondaryCursor.ndcY = second.y;
      this.state.secondaryCursor.screenX = (second.x * 0.5 + 0.5) * viewWidth;
      this.state.secondaryCursor.screenY = (-second.y * 0.5 + 0.5) * viewHeight;
      this.state.secondaryCursor.active = true;
    } else {
      this.state.secondaryCursor.active = false;
    }

    // ── Щипок с гистерезисом.
    const ratio = this.#pinchFilter.push(this.#rawPinchRatio, dt);
    const wasPinching = this.state.pinch.active;
    if (!wasPinching && ratio < PINCH_ENTER) this.state.pinch.active = true;
    else if (wasPinching && ratio > PINCH_EXIT) this.state.pinch.active = false;
    this.state.pinch.strength = Math.min(1, Math.max(0, (PINCH_EXIT - ratio) / (PINCH_EXIT - PINCH_ENTER * 0.6)));
    this.state.secondaryPinch = this.#rawSecondaryPinchRatio < PINCH_ENTER;

    // ── Поза.
    this.state.pose = this.#rawPose;
    this.#updateTwoHand(dt);
    this.#updateSwipe(dt);
    this.#updateHolds(dt);
  }

  /** Точка «захвата»: обычно кончик указательного, при щипке — середина большого и указательного. */
  #cursorPoint(landmarks: Parameters<typeof palmCenter>[0], pinching: boolean): { x: number; y: number } {
    if (!pinching) return { x: landmarks[8].x, y: landmarks[8].y };
    return {
      x: (landmarks[4].x + landmarks[8].x) * 0.5,
      y: (landmarks[4].y + landmarks[8].y) * 0.5,
    };
  }

  /** Нормализованные координаты кадра → NDC с учётом зеркала и чувствительности. */
  mapToNdc(x: number, y: number): { x: number; y: number } {
    const { mirror, sensitivity } = this.#options;
    let nx = (x - 0.5) * 2;
    if (mirror) nx = -nx;
    const ny = (y - 0.5) * 2;
    const gain = Math.min(3, Math.max(0.4, sensitivity));
    return {
      x: Math.min(1.15, Math.max(-1.15, nx * gain)),
      y: Math.min(1.15, Math.max(-1.15, -ny * gain)),
    };
  }

  /** Поза «залипает» на пару кадров: классификация на отдельных кадрах иногда мигает. */
  #stickyPose(pose: HandPose): HandPose {
    if (pose === this.#rawPose) {
      this.#poseSince = this.#time;
      return pose;
    }
    if (this.#time - this.#poseSince < POSE_STICKY && this.#rawPose !== 'none') return this.#rawPose;
    this.#poseSince = this.#time;
    return pose;
  }

  #updateTwoHand(dt: number): void {
    const bothVisible = this.state.cursor.active && this.state.secondaryCursor.active;
    const freeHands = bothVisible && !this.state.pinch.active && !this.state.secondaryPinch;

    if (!freeHands) {
      if (this.#twoHandArmed) {
        this.#twoHandArmed = false;
        this.state.twoHand.active = false;
        this.state.twoHand.twist = 0;
        this.#twoHandTwist = 0;
      }
      return;
    }

    const ax = this.state.cursor.ndcX;
    const ay = this.state.cursor.ndcY;
    const bx = this.state.secondaryCursor.ndcX;
    const by = this.state.secondaryCursor.ndcY;
    const distance = Math.max(0.05, Math.hypot(bx - ax, by - ay));
    const angle = angleBetween(ax, ay, bx, by);

    if (!this.#twoHandArmed) {
      this.#twoHandArmed = true;
      this.#twoHandBaseline = distance;
      this.#twoHandPrevAngle = angle;
      this.#twoHandScale = 1;
      this.#twoHandTwist = 0;
    }

    this.#twoHandScale = Math.min(5, Math.max(0.2, distance / this.#twoHandBaseline));
    this.#twoHandTwist += angleDelta(this.#twoHandPrevAngle, angle);
    this.#twoHandPrevAngle = angle;

    this.state.twoHand.active = true;
    this.state.twoHand.scale = this.#twoHandScale;
    // Поворот отдаём как приращение за кадр: сцена складывает его сама (инерция остаётся у неё).
    this.state.twoHand.twist = this.#twoHandTwist;
    this.#twoHandTwist = 0;
    this.state.twoHand.centerX = (ax + bx) * 0.5;
    this.state.twoHand.centerY = (ay + by) * 0.5;

    // Если руки расходятся/сходятся слишком сильно, обновляем базу — иначе зум «упирается».
    if (this.#twoHandScale > 3.5 || this.#twoHandScale < 0.3) {
      this.#twoHandBaseline = distance;
      this.#twoHandScale = 1;
    }
    void dt;
  }

  /** Свайп открытой ладонью влево/вправо. */
  #updateSwipe(dt: number): void {
    if (this.#swipeCooldown > 0) this.#swipeCooldown -= dt;
    const palmX = this.state.cursor.ndcX;
    const velocity = dt > 0 ? (palmX - this.#lastPalmX) / dt : 0;
    this.#lastPalmX = palmX;
    // Сглаживаем скорость, чтобы одиночный «рывок» распознавания не давал ложный свайп.
    this.#swipeVelocity = this.#swipeVelocity * 0.7 + velocity * 0.3;

    const canSwipe =
      this.state.pose === 'open' &&
      !this.state.pinch.active &&
      this.state.cursor.active &&
      this.#swipeCooldown <= 0 &&
      Math.abs(this.#swipeVelocity) > SWIPE_SPEED;

    if (!canSwipe) return;
    const name: GestureName = this.#swipeVelocity > 0 ? 'swipe-right' : 'swipe-left';
    this.#swipeCooldown = 0.9;
    this.#swipeVelocity = 0;
    this.#emitter.emit(name, name);
  }

  /**
   * Командные жесты с удержанием: открытая ладонь (пауза), кулак (сброс), большой палец вверх.
   * Пока жест удерживается, в состоянии растёт `holdProgress` — по нему рисуется кольцо,
   * поэтому пользователь видит, что команда «назревает».
   */
  #updateHolds(dt: number): void {
    if (this.#cooldown > 0) this.#cooldown -= dt;

    const pose = this.state.pose;
    const isHoldPose = pose === 'open' || pose === 'fist' || pose === 'thumbsUp';
    const pauseEnabled = this.#options.pauseGesture || pose !== 'open';

    if (!isHoldPose || !pauseEnabled || this.#cooldown > 0 || this.state.pinch.active) {
      this.#poseHold = 0;
      this.#poseHoldTarget = null;
      this.state.holdLabel = null;
      this.state.holdProgress = 0;
      return;
    }

    // Открытая ладонь срабатывает только «на месте»: если рука летит, это свайп, а не пауза.
    if (pose === 'open' && Math.abs(this.#swipeVelocity) > SWIPE_SPEED * 0.6) {
      this.#poseHold = 0;
      this.state.holdProgress = 0;
      this.state.holdLabel = null;
      return;
    }

    if (this.#poseHoldTarget !== pose) {
      this.#poseHoldTarget = pose;
      this.#poseHold = 0;
    }

    const target = HOLD_TIMES[pose as 'open' | 'fist' | 'thumbsUp'];
    this.#poseHold += dt;
    this.state.holdLabel = pose === 'open' ? 'пауза' : pose === 'fist' ? 'сброс' : 'действие';
    this.state.holdProgress = Math.min(1, this.#poseHold / target);

    if (this.#poseHold < target) return;

    const name: GestureName = pose === 'open' ? 'palm-pause' : pose === 'fist' ? 'fist-reset' : 'thumbs-up';
    this.#cooldown = HOLD_COOLDOWN;
    this.#poseHold = 0;
    this.#poseHoldTarget = null;
    this.state.holdLabel = null;
    this.state.holdProgress = 0;
    this.#emitter.emit(name, name);
  }

  /** Сбросить всё (при выключении камеры). */
  reset(): void {
    this.#hasFrame = false;
    this.state.cursor.active = false;
    this.state.secondaryCursor.active = false;
    this.state.handsCount = 0;
    this.state.pose = 'none';
    this.state.pinch.active = false;
    this.state.pinch.strength = 0;
    this.state.pinch.progress = 0;
    this.state.grabbed = false;
    this.state.twoHand.active = false;
    this.state.holdLabel = null;
    this.state.holdProgress = 0;
    this.#poseHold = 0;
    this.#poseHoldTarget = null;
    this.#cooldown = 0;
    this.#swipeCooldown = 0;
    this.#swipeVelocity = 0;
    this.#twoHandArmed = false;
    this.#pointFilter.reset();
    this.#pinchFilter.reset();
    this.#secondaryFilter.reset();
  }
}
