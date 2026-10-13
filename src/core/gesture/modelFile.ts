/**
 * Файл модели руки: откуда берём и как проверяем.
 *
 * Почему проверка не «начинается с PK». Официальный `hand_landmarker.task` (float16, 7 819 105 байт)
 * — это ZIP-контейнер, но перед ZIP-сигнатурой у него стоят два нулевых байта:
 *
 * ```
 * 00 00 50 4b 03 04 …      ← реальное начало файла модели
 * ```
 *
 * Поэтому строгая проверка «PK в первых двух байтах» отвергала **настоящую** модель: распознавание
 * не запускалось, хотя файл был скачан правильно. Теперь ищем ZIP-локальный заголовок в первых
 * 64 байтах и центральный каталог в хвосте — это отсекает HTML-заглушки, но принимает модель.
 *
 * Источники перечислены в порядке предпочтения: локальная копия (офлайн) → официальный Google Storage
 * → зеркала на CDN npm. Зеркала нужны потому, что `storage.googleapis.com` доступен не везде.
 */

/** Минимальный осмысленный размер модели: отсекает HTML-заглушки и обрывки загрузки. */
export const MODEL_MIN_BYTES = 100_000;

/** Куда `npm run fetch:models` кладёт модель (папка в .gitignore). */
export const MODEL_LOCAL = '/models/hand_landmarker.task';

/** Официальный адрес модели MediaPipe (Apache-2.0). */
const MODEL_GOOGLE =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/**
 * Зеркало на CDN npm. Источник файла — пакет `expo-vision-camera-v4-mediapipe@1.4.0`, внутри которого
 * лежит ровно тот же `hand_landmarker.task` (sha256 fbc2a300…, совпадает с GitHub-зеркалами).
 * Проверено: размер 7 819 105 байт, содержимое — `hand_detector.tflite` + `hand_landmarks_detector.tflite`.
 */
const MODEL_JSDELIVR =
  'https://cdn.jsdelivr.net/npm/expo-vision-camera-v4-mediapipe@1.4.0/hand_landmarker.task';
/** Второе зеркало npm — на случай, если jsDelivr недоступен. */
const MODEL_UNPKG = 'https://unpkg.com/expo-vision-camera-v4-mediapipe@1.4.0/hand_landmarker.task';

/** Все адреса модели в порядке предпочтения (локальный — первым). */
export const MODEL_SOURCES: readonly string[] = [
  MODEL_LOCAL,
  MODEL_GOOGLE,
  MODEL_JSDELIVR,
  MODEL_UNPKG,
];

/** Сигнатура ZIP-локального заголовка: `PK\x03\x04`. */
function hasZipLocalHeader(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i + 3 < to; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      return true;
    }
  }
  return false;
}

/** Сигнатура «конец центрального каталога»: `PK\x05\x06`. */
function hasZipEndRecord(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i + 3 < to; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return true;
    }
  }
  return false;
}

/**
 * Похожи ли байты на контейнер `.task`:
 *  • размер не меньше 100 КБ;
 *  • ZIP-заголовок в первых 64 байтах (у модели перед ним два нулевых байта);
 *  • запись конца центрального каталога где-то в последних 64 КБ.
 */
export function looksLikeTaskFile(bytes: Uint8Array): boolean {
  if (bytes.length < MODEL_MIN_BYTES) return false;
  if (!hasZipLocalHeader(bytes, 0, Math.min(64, bytes.length))) return false;
  const tailStart = Math.max(0, bytes.length - 65_536);
  return hasZipEndRecord(bytes, tailStart, bytes.length);
}
