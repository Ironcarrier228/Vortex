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
 * Если пакета нет (не выполнен `npm install`) — это не ошибка: распознавание рук
 * опция, приложение соберётся и будет работать, а библиотека подтянется с CDN.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const targetDir = join(root, 'public', 'mediapipe');

const HINT =
  'выполните `npm install` — без локальной копии библиотека будет загружаться с CDN ' +
  '(нужен интернет), а распознавание рук останется доступным.';

if (!existsSync(packageDir)) {
  console.warn(`[sync-mediapipe] нет node_modules/@mediapipe/tasks-vision — ${HINT}`);
  process.exit(0);
}

mkdirSync(join(targetDir, 'wasm'), { recursive: true });

// 1. Библиотека (классический IIFE-бандл, глобал `Vision`): её грузит src/core/gesture/mediapipe.ts.
const bundle = join(packageDir, 'vision_bundle.js');
if (existsSync(bundle)) {
  cpSync(bundle, join(targetDir, 'vision_bundle.js'));
} else {
  console.warn(`[sync-mediapipe] в пакете нет vision_bundle.js — ${HINT}`);
}

// 2. WASM-ядро.
const wasmDir = join(packageDir, 'wasm');
let copied = 0;
let totalMb = 0;
if (existsSync(wasmDir)) {
  for (const file of readdirSync(wasmDir)) {
    const source = join(wasmDir, file);
    if (!statSync(source).isFile()) continue;
    cpSync(source, join(targetDir, 'wasm', file));
    copied += 1;
    totalMb += statSync(source).size / 1024 ** 2;
  }
}

console.log(
  `[sync-mediapipe] готово: public/mediapipe (библиотека + ${copied} файлов WASM, ${totalMb.toFixed(1)} МБ). ` +
    'Папка в .gitignore: она восстанавливается этой командой.',
);
