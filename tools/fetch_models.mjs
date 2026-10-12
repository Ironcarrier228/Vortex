/**
 * Скачивает модель руки MediaPipe для работы без интернета.
 *
 *   npm run fetch:models
 *
 * Что делает: кладёт `hand_landmarker.task` в `public/models/`. Приложение ищет модель
 * сначала там, и только потом идёт в CDN — то есть после этой команды распознавание рук
 * работает полностью офлайн, в том числе в собранном Tauri-приложении.
 *
 * Лицензия: модель MediaPipe распространяется под Apache-2.0, но лежит в .gitignore —
 * бинарники в репозитории не нужны, скрипт восстанавливает её одной командой.
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'models', 'hand_landmarker.task');

const SOURCES = [
  // Официальный адрес модели MediaPipe (см. документацию tasks-vision: HandLandmarker → models).
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
];

const MIN_BYTES = 100_000;

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // .task — это zip; проверяем сигнатуру, чтобы не сохранить HTML-заглушку прокси.
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (bytes.length < MIN_BYTES || !isZip) {
    throw new Error(`получено ${bytes.length} байт, это не похоже на .task`);
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
      console.log(`[fetch-models] готово: public/models/hand_landmarker.task (${(bytes.length / 1024 ** 2).toFixed(1)} МБ)`);
      return;
    } catch (error) {
      console.warn(`[fetch-models] не получилось: ${error.message}`);
    }
  }

  console.error(
    '[fetch-models] не удалось скачать модель.\n' +
      'Скачайте hand_landmarker.task вручную и положите в public/models/:\n' +
      '  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task\n' +
      'Без файла жесты работают через CDN (нужен интернет) либо в демо-режиме: ?hand=demo',
  );
  process.exitCode = 1;
}

void main();
