/**
 * Готовит локальную (офлайновую) копию MediaPipe Tasks Vision в `public/mediapipe/`:
 *  • `vision_bundle.js` — библиотека распознавания (≈156 КБ). Именно классический бандл,
 *    а не `.mjs`: он кладёт всё на глобальный объект `Vision`, поэтому подключается тегом
 *    `<script>` — файлы из `public/` нельзя импортировать из кода (Vite это запрещает);
 *  • `wasm/*` — WASM-ядро (≈37 МБ, три сборки: SIMD, module, nosimd).
 *
 * Зачем копировать, а не брать с CDN: приложение должно запускаться без интернета
 * (Windows-сборка, самолёт, закрытый контур). Скрипт выполняется автоматически
 * перед `npm run dev` и `npm run build` (хуки predev/prebuild).
 *
 * Особенности Windows (из-за них скрипт специально «нежный»):
 *  • `fs.cpSync` перед записью удаляет приёмник — если файл занят (WebView2 ещё держит WASM
 *    после `app:dev`, антивирус сканирует 37 МБ), падает с загадочным «operation completed
 *    successfully». Поэтому: если размеры совпадают — файл не трогаем вообще, а если нужно
 *    обновить — пишем поверх (`writeFileSync`), без удаления;
 *  • блокировка может быть временной, поэтому есть повторы с паузой.
 *
 * Неудача копирования **не** валит сборку: жесты — опция, без локальной копии библиотека
 * и WASM подтянутся с CDN (нужен интернет). Скрипт предупредит и продолжит.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const targetDir = join(root, 'public', 'mediapipe');

const HINT =
  'выполните `npm install` — без локальной копии библиотека будет загружаться с CDN ' +
  '(нужен интернет), а распознавание рук останется доступным.';

const attempts = 4;

let copied = 0;
let skipped = 0;
let failed = 0;
let totalMb = 0;

function addSize(bytes) {
  totalMb += bytes / 1024 ** 2;
}

/**
 * Копирует файл, не удаляя приёмник. Возвращает:
 *  • `'same'` — на месте уже такой же файл (не трогаем: он может быть занят);
 *  • `'copied'` — перезаписали;
 *  • `'failed'` — не получилось ни за один повтор.
 */
function copyFile(from, to) {
  const source = statSync(from);
  if (existsSync(to)) {
    const target = statSync(to);
    if (target.size === source.size) return 'same';
  }

  const bytes = readFileSync(from);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // writeFileSync пишет поверх файла — в отличие от cpSync, без предварительного unlink.
      writeFileSync(to, bytes);
      return 'copied';
    } catch (err) {
      if (attempt === attempts) {
        console.warn(`[sync-mediapipe] не удалось обновить ${to}: ${err.message}`);
        return 'failed';
      }
      // Занятый файл обычно освобождается через доли секунды: даём шанс.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt);
    }
  }
  return 'failed';
}

if (!existsSync(packageDir)) {
  console.warn(`[sync-mediapipe] нет node_modules/@mediapipe/tasks-vision — ${HINT}`);
  process.exit(0);
}

mkdirSync(join(targetDir, 'wasm'), { recursive: true });

// 1. Библиотека (классический IIFE-бандл, глобал `Vision`): её грузит src/core/gesture/mediapipe.ts.
const bundle = join(packageDir, 'vision_bundle.js');
if (existsSync(bundle)) {
  const result = copyFile(bundle, join(targetDir, 'vision_bundle.js'));
  if (result === 'copied') copied += 1;
  else if (result === 'same') skipped += 1;
  else failed += 1;
  addSize(statSync(bundle).size);
} else {
  console.warn(`[sync-mediapipe] в пакете нет vision_bundle.js — ${HINT}`);
}

// 2. WASM-ядро.
const wasmDir = join(packageDir, 'wasm');
if (existsSync(wasmDir)) {
  for (const file of readdirSync(wasmDir)) {
    const source = join(wasmDir, file);
    if (!statSync(source).isFile()) continue;
    const result = copyFile(source, join(targetDir, 'wasm', file));
    if (result === 'copied') copied += 1;
    else if (result === 'same') skipped += 1;
    else failed += 1;
    addSize(statSync(source).size);
  }
}

const parts = [`обновлено ${copied}`, `уже на месте ${skipped}`];
if (failed > 0) parts.push(`не удалось ${failed}`);

console.log(
  `[sync-mediapipe] public/mediapipe: ${parts.join(', ')} (${totalMb.toFixed(1)} МБ). ` +
    'Папка в .gitignore: она восстанавливается этой командой.',
);

if (failed > 0) {
  console.warn(
    '[sync-mediapipe] часть файлов занята другим процессом (обычно WebView2 или антивирус). ' +
      'Сборка продолжится, локальная копия просто останется прежней. Если нужен офлайн-режим — ' +
      'закройте приложение/`npm run dev` и повторите `npm run sync:mediapipe`.',
  );
}
