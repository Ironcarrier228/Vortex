/**
 * Копирует WASM-файлы MediaPipe из node_modules в public/mediapipe/wasm.
 *
 * Зачем копировать, а не брать с CDN: приложение должно запускаться без интернета
 * (Windows-сборка, самолёт, закрытый контур). Скрипт выполняется автоматически
 * перед `npm run dev` и `npm run build` (хуки predev/prebuild).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(from)) {
  console.warn('[sync-mediapipe] нет node_modules/@mediapipe/tasks-vision/wasm — выполните npm install');
  process.exit(0);
}

mkdirSync(to, { recursive: true });
let copied = 0;
for (const file of readdirSync(from)) {
  const source = join(from, file);
  if (!statSync(source).isFile()) continue;
  cpSync(source, join(to, file));
  copied += 1;
}

const totalMb = readdirSync(to)
  .map((file) => statSync(join(to, file)).size)
  .reduce((sum, size) => sum + size, 0) / 1024 ** 2;

console.log(
  `[sync-mediapipe] ${copied} файлов → public/mediapipe/wasm (${totalMb.toFixed(1)} МБ). ` +
    'Папка в .gitignore: она восстанавливается этой командой.',
);
