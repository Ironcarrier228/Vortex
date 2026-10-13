/**
 * Скачивает модель руки MediaPipe для работы без интернета.
 *
 *   npm run fetch:models
 *
 * Что делает: кладёт `hand_landmarker.task` в `public/models/`. Приложение ищет модель
 * сначала там, и только потом идёт в интернет (официальный Google Storage → зеркала на
 * CDN npm) — то есть после этой команды распознавание рук работает полностью офлайн,
 * в том числе в собранном Tauri-приложении и без обращений наружу.
 *
 * Лицензия: модель MediaPipe распространяется под Apache-2.0, но лежит в .gitignore —
 * бинарники в репозитории не нужны, скрипт восстанавливает её одной командой.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'models', 'hand_landmarker.task');

/** Порядок источников: официальный, затем зеркала (в РФ Google Storage часто недоступен). */
const SOURCES = [
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  // Зеркало: тот же файл внутри npm-пакета (CDN ходит через jsDelivr/unpkg).
  'https://cdn.jsdelivr.net/npm/expo-vision-camera-v4-mediapipe@1.4.0/hand_landmarker.task',
  'https://unpkg.com/expo-vision-camera-v4-mediapipe@1.4.0/hand_landmarker.task',
];

const MIN_BYTES = 100_000;

/**
 * Контейнер `.task` — это ZIP, но у официальной модели перед ZIP-сигнатурой стоят два
 * нулевых байта (`00 00 50 4b 03 04`). Поэтому ищем заголовок в первых 64 байтах и
 * запись конца каталога в хвосте — так же, как это делает фронтенд (`modelFile.ts`).
 */
function looksLikeTaskFile(bytes) {
  if (bytes.length < MIN_BYTES) return false;
  const header = bytes.subarray(0, Math.min(64, bytes.length));
  let hasHeader = false;
  for (let i = 0; i + 3 < header.length; i++) {
    if (header[i] === 0x50 && header[i + 1] === 0x4b && header[i + 2] === 0x03 && header[i + 3] === 0x04) {
      hasHeader = true;
      break;
    }
  }
  if (!hasHeader) return false;
  const tail = bytes.subarray(Math.max(0, bytes.length - 65_536));
  for (let i = 0; i + 3 < tail.length; i++) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return true;
  }
  return false;
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!looksLikeTaskFile(bytes)) {
    throw new Error(`получено ${bytes.length} байт, это не похоже на контейнер .task`);
  }
  return bytes;
}

async function main() {
  if (existsSync(target) && statSync(target).size > MIN_BYTES) {
    const mb = (statSync(target).size / 1024 ** 2).toFixed(1);
    console.log(`[fetch-models] модель уже на месте: public/models/hand_landmarker.task (${mb} МБ)`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  for (const url of SOURCES) {
    try {
      process.stdout.write(`[fetch-models] качаю ${url}\n`);
      const bytes = await download(url);
      writeFileSync(target, bytes);
      console.log(
        `[fetch-models] готово: public/models/hand_landmarker.task (${(bytes.length / 1024 ** 2).toFixed(1)} МБ). ` +
          'Теперь жесты работают без интернета — приложение не ходит наружу.',
      );
      return;
    } catch (error) {
      console.warn(`[fetch-models] не получилось: ${error.message}`);
    }
  }

  console.error(
    '[fetch-models] не удалось скачать модель ни с одного адреса.\n' +
      'Варианты:\n' +
      '  1) скачайте hand_landmarker.task вручную и положите в public/models/\n' +
      '     https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task\n' +
      '  2) ничего не делайте: приложение возьмёт модель из интернета само (Google Storage или зеркало),\n' +
      '     а если и это не выйдет — покажет демо-руку без камеры и модели (`?hand=demo`).',
  );
  process.exitCode = 1;
}

void main();
