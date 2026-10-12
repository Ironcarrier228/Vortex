/**
 * Чистая геометрия кисти: без DOM, без MediaPipe и без состояния.
 * Всё здесь покрыто тестами (tools/smoke.test.ts) — именно эти формулы определяют,
 * насколько «послушно» рука управляет сценами.
 *
 * Индексы точек стандартные (MediaPipe Hand Landmarks, 21 точка):
 * ```
 *   0 wrist
 *   1..4   thumb (4 — кончик)
 *   5..8   index (8 — кончик)
 *   9..12  middle (12 — кончик)
 *   13..16 ring   (16 — кончик)
 *   17..20 pinky  (20 — кончик)
 * ```
 */

import type { HandPose, Landmark } from './types';

export const WRIST = 0;
export const THUMB_TIP = 4;
export const THUMB_IP = 3;
export const INDEX_MCP = 5;
export const INDEX_PIP = 6;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;
export const MIDDLE_PIP = 10;
export const MIDDLE_TIP = 12;
export const RING_MCP = 13;
export const RING_PIP = 14;
export const RING_TIP = 16;
export const PINKY_MCP = 17;
export const PINKY_PIP = 18;
export const PINKY_TIP = 20;

/** Пары точек для отрисовки скелета (совпадают с HandLandmarker.HAND_CONNECTIONS). */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Порог «щипок начался» (отношение расстояние кончиков / размер кисти). */
export const PINCH_ENTER = 0.42;
/** Порог «щипок закончился» — выше, чем вход: гистерезис гасит дребезг на границе. */
export const PINCH_EXIT = 0.62;

type Point = Pick<Landmark, 'x' | 'y'>;

export function distance2d(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Масштаб кисти: расстояние «запястье → основание среднего пальца».
 * Все отношения считаем к нему, поэтому жесты одинаково работают и у монитора,
 * и в двух метрах от камеры.
 */
export function handScale(landmarks: Landmark[]): number {
  if (landmarks.length < 21) return 1e-4;
  const scale = distance2d(landmarks[WRIST], landmarks[MIDDLE_MCP]);
  return scale > 1e-4 ? scale : 1e-4;
}

/** Отношение расстояния «большой—указательный» к размеру кисти. Меньше — ближе к щипку. */
export function pinchRatio(landmarks: Landmark[]): number {
  if (landmarks.length < 21) return 1;
  return distance2d(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / handScale(landmarks);
}

/** Центр ладони — среднее запястья и четырёх оснований пальцев. */
export function palmCenter(landmarks: Landmark[]): { x: number; y: number } {
  const indices = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  let x = 0;
  let y = 0;
  for (const index of indices) {
    x += landmarks[index].x;
    y += landmarks[index].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

/** Кончик пальца «выпрямлен», если он дальше от запястья, чем средний сустав. */
export function fingerExtended(landmarks: Landmark[], tip: number, pip: number): boolean {
  if (landmarks.length < 21) return false;
  const wrist = landmarks[WRIST];
  const tipDistance = distance2d(landmarks[tip], wrist);
  const pipDistance = distance2d(landmarks[pip], wrist);
  return tipDistance > pipDistance * 1.12;
}

/**
 * Большой палец отставлен. Два условия вместе: палец разогнут (кончик заметно дальше от
 * запястья, чем сустав IP) и уведён от основания указательного. Так «класс» не путается
 * с кулаком, где большой палец лежит поперёк пальцев.
 */
export function thumbExtended(landmarks: Landmark[]): boolean {
  const wrist = landmarks[WRIST];
  const straightened =
    distance2d(landmarks[THUMB_TIP], wrist) > distance2d(landmarks[THUMB_IP], wrist) * 1.3;
  const awayFromIndex = distance2d(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) / handScale(landmarks) > 0.55;
  return straightened && awayFromIndex;
}

export interface FingerStates {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

export function fingerStates(landmarks: Landmark[]): FingerStates {
  return {
    thumb: thumbExtended(landmarks),
    index: fingerExtended(landmarks, INDEX_TIP, INDEX_PIP),
    middle: fingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP),
    ring: fingerExtended(landmarks, RING_TIP, RING_PIP),
    pinky: fingerExtended(landmarks, PINKY_TIP, PINKY_PIP),
  };
}

/**
 * Классификация позы. Порядок проверок важен: щипок определяется первым (он самый
 * «быстрый» жест), затем кулак, ладонь, большой палец вверх и указание.
 */
export function classifyPose(landmarks: Landmark[], pinchActive: boolean): HandPose {
  if (landmarks.length < 21) return 'none';
  if (pinchActive) return 'pinch';

  const fingers = fingerStates(landmarks);
  const scale = handScale(landmarks);
  const extendedCount = [fingers.index, fingers.middle, fingers.ring, fingers.pinky].filter(Boolean).length;

  if (extendedCount === 0) {
    if (!fingers.thumb) return 'fist';
    // Все четыре пальца сжаты, большой отставлен: либо «класс», либо нейтральное положение.
    // В кадре y растёт вниз, поэтому поднятый вверх большой палец имеет меньший y, чем запястье.
    const wrist = landmarks[WRIST];
    const tip = landmarks[THUMB_TIP];
    return wrist.y - tip.y > 0.5 * scale ? 'thumbsUp' : 'none';
  }

  // Указание: выпрямлен только указательный.
  if (fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) return 'point';

  // Открытая ладонь: все четыре пальца выпрямлены.
  if (extendedCount === 4) return 'open';

  // Промежуточные состояния (два-три пальца) — «none», чтобы не дёргать сцены.
  return 'none';
}

/** Угол между линиями «ладонь A → ладонь B» в двух кадрах — для поворота сцены двумя руками. */
export function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** Разница углов с учётом перехода через ±π. */
export function angleDelta(a: number, b: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Синтетический скелет кисти (для демо-режима без камеры и для тестов).
 * Возвращает 21 точку в координатах кадра.
 */
export function makeSyntheticHand(options: {
  centerX: number;
  centerY: number;
  /** Размер кисти в тех же нормализованных координатах кадра. */
  size: number;
  /** Поворот всей кисти, радианы. */
  rotation?: number;
  /** 0 — пальцы сжаты, 1 — раскрыты. */
  openness?: number;
  /** 0 — нет щипка, 1 — большой и указательный сомкнуты. */
  pinch?: number;
  /** Большой палец поднят вверх (жест «класс»). */
  thumbsUp?: boolean;
}): Landmark[] {
  const { centerX, centerY, size } = options;
  const rotation = options.rotation ?? 0;
  const pinch = Math.min(1, Math.max(0, options.pinch ?? 0));
  const openness = options.thumbsUp ? 0.12 : Math.min(1, Math.max(0.1, options.openness ?? 1));

  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const place = (dx: number, dy: number): Landmark => ({
    x: centerX + (dx * cosR - dy * sinR) * size,
    y: centerY + (dx * sinR + dy * cosR) * size,
    z: 0,
  });

  const landmarks: Landmark[] = new Array(21).fill(null).map(() => place(0, 0));
  landmarks[WRIST] = place(0, 0.95);

  // Основания пальцев — по дуге.
  const mcpAngles = [-0.42, -0.14, 0.08, 0.3];
  const mcpIndices = [INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  const tipIndices = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
  const pipIndices = [INDEX_PIP, MIDDLE_PIP, RING_PIP, PINKY_PIP];
  const lengths = [0.78, 0.85, 0.78, 0.62];

  for (let finger = 0; finger < 4; finger++) {
    const angle = mcpAngles[finger];
    const mcp = place(Math.sin(angle) * 0.75, -0.1 + Math.cos(angle) * 0.05);
    landmarks[mcpIndices[finger]] = mcp;

    // Указательный выпрямлен при щипке (кончик тянется к большому пальцу), в остальных
    // позах он подчиняется общей раскрытости — иначе кулак выглядел бы как «указание».
    const curl = finger === 0 ? Math.max(openness, pinch) : openness;
    const length = lengths[finger] * (0.25 + 0.75 * curl);
    const tip = place(
      Math.sin(angle) * (0.75 + length),
      -0.1 + Math.cos(angle) * 0.05 - length * 0.95 * (0.35 + 0.65 * curl) + (1 - curl) * 0.55,
    );
    landmarks[tipIndices[finger]] = tip;
    landmarks[pipIndices[finger]] = {
      x: mcp.x * 0.45 + tip.x * 0.55,
      y: mcp.y * 0.45 + tip.y * 0.55,
      z: 0,
    };
  }

  // Большой палец.
  if (options.thumbsUp) {
    // Отставлен строго вверх — так его и видит настоящая камера на жесте «класс».
    landmarks[1] = place(-0.45, 0.3);
    landmarks[2] = place(-0.42, -0.05);
    landmarks[THUMB_IP] = place(-0.36, -0.62);
    landmarks[THUMB_TIP] = place(-0.3, -1.3);
    return landmarks;
  }

  const thumbSpread = (1 - pinch) * 0.55;
  landmarks[1] = place(-0.55, 0.35);
  landmarks[2] = place(-0.75 - thumbSpread * 0.3, 0.15 - thumbSpread * 0.2);
  landmarks[THUMB_IP] = place(-0.85 - thumbSpread * 0.5, -0.05 - thumbSpread * 0.45);
  const indexTip = landmarks[INDEX_TIP];
  const openThumbTip = place(-0.95 - thumbSpread * 0.6, -0.2 - thumbSpread * 0.5);
  landmarks[THUMB_TIP] = {
    x: openThumbTip.x * (1 - pinch) + indexTip.x * pinch,
    y: openThumbTip.y * (1 - pinch) + indexTip.y * pinch,
    z: 0,
  };

  return landmarks;
}
