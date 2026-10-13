/**
 * Смоук-тест «головы» фронтенда без DOM/WebGL: проверяет аудиошину и мок-бэкенд
 * (генератор спектра, дерево диска, снимки сети).
 *
 * Запуск:
 *   npx esbuild tools/smoke.test.ts --bundle --format=esm --platform=node --outfile=/tmp/vortex-smoke.mjs
 *   node /tmp/vortex-smoke.mjs
 */

// Node-харнесс: мок-бэкенд использует window.setInterval, как и в браузере.
const globals = globalThis as unknown as {
  window?: typeof globalThis;
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};
if (!globals.window) globals.window = globalThis;
// Демо-источник рук рассчитан на браузерный цикл кадров: в Node подменяем его таймером.
if (!globals.requestAnimationFrame) {
  globals.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  globals.cancelAnimationFrame = () => undefined;
}

import { installMockBackend } from '../src/core/mock/backend';
import { AudioBus } from '../src/core/audio/bus';
import { invoke, listen } from '../src/core/transport';
import { PINCH_ENTER, PINCH_EXIT, classifyPose, makeSyntheticHand, pinchRatio } from '../src/core/gesture/landmarks';
import { MODEL_SOURCES, looksLikeTaskFile } from '../src/core/gesture/modelFile';
import { GestureController } from '../src/core/gesture/gestureController';
import { DemoHandSource } from '../src/core/gesture/demoHand';
import { loadMediaPipe } from '../src/core/gesture/mediapipe';
import { PointerHub } from '../src/core/interaction/pointer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';
import type { HandFrame, Landmark } from '../src/core/gesture/types';
import type { DiskNodeInfo, NetSnapshot } from '../src/core/types';

let failures = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  installMockBackend();

  console.log('Аудиошина + мок-спектр');
  const bus = new AudioBus();
  const snapshots: number[] = [];
  bus.subscribe((snapshot) => snapshots.push(snapshot.energy));

  const info = await invoke<{ available: boolean; device?: string }>('audio_start');
  check(info.available === true, `audio_start вернул available=true (${info.device})`);

  await wait(700);
  for (let frame = 0; frame < 60; frame++) {
    bus.update(1 / 60);
    await wait(1);
  }
  check(bus.source === 'system', `источник переключился на системный поток (${bus.source})`);
  check(bus.snapshot.energy > 0.05, `энергия сигнала > 0.05 (${bus.snapshot.energy.toFixed(3)})`);
  check(bus.snapshot.bass > bus.snapshot.treble, 'бас громче верха (ожидаемо для синтетики)');
  check(snapshots.length > 40, `снимки рассылаются подписчикам (${snapshots.length})`);
  const bands = Array.from(bus.bands);
  check(bands.every((value) => value >= 0 && value <= 1), 'полосы нормализованы в 0..1');

  await invoke('audio_set_active', { active: false });
  await invoke('audio_stop');

  console.log('Сеть: снимки и дельты');
  const snapshotsSeen: NetSnapshot[] = [];
  const off = listen<NetSnapshot>('vortex://net/snapshot', (snapshot) => snapshotsSeen.push(snapshot));
  const started = await invoke<NetSnapshot>('net_start', { pollMs: 500 });
  check(Array.isArray(started.connections) && started.connections.length > 5, `net_start вернул ${started.connections?.length ?? 0} соединений`);
  await wait(1300);
  check(snapshotsSeen.length >= 2, `пришло событий net/snapshot: ${snapshotsSeen.length}`);
  const last = snapshotsSeen.at(-1);
  check(Boolean(last?.added?.length), `есть дельта added для импульсов (${last?.added?.length ?? 0})`);
  check(Boolean(last?.connections.every((c) => c.id.startsWith('tcp:') || c.id.startsWith('udp:'))), 'формат id совпадает с Rust-схемой');
  check(Boolean(last?.origin?.lat !== undefined), 'для глобуса пришла локальная позиция');
  off();
  await invoke('net_stop');

  console.log('Диск: скан, дети, удаление в корзину');
  await invoke('disk_scan', { root: 'C:\\' });
  await wait(1600);
  const stats = await invoke<{ done: boolean; files: number; bytes: number }>('disk_stats');
  check(stats.done === true, `скан завершён (файлов ${stats.files}, ${(stats.bytes / 1024 ** 3).toFixed(2)} ГБ)`);

  const children = await invoke<DiskNodeInfo[]>('disk_children', { path: 'C:\\' });
  check(children.length > 3, `дети корня получены (${children.length})`);
  check(children.every((child) => Boolean(child.category)), 'у каждого узла есть категория для окраски');
  check(
    children[0].size >= children[children.length - 1].size,
    'дети отсортированы по размеру (крупнейшие сверху)',
  );

  const victim = children.find((child) => child.isDir) ?? children[0];
  await invoke('disk_delete_to_trash', { path: victim.path });
  const after = await invoke<DiskNodeInfo[]>('disk_children', { path: 'C:\\' });
  check(!after.some((child) => child.id === victim.id), `удалённый объект исчез из дерева (${victim.name})`);

  const emptyRoot = await invoke<DiskNodeInfo[]>('disk_children', { path: 'Z:\\nope' });
  check(Array.isArray(emptyRoot) && emptyRoot.length === 0, 'несуществующий путь даёт пустой список, а не падение');

  console.log('Жесты: геометрия кисти (21 точка, нормировка на размер кисти)');
  const openHand = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, openness: 1 });
  const fistHand = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, openness: 0 });
  const pinchHand = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, pinch: 1 });
  const thumbsHand = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, thumbsUp: true });
  const smallPinch = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.12, pinch: 1 });

  check(openHand.length === 21 && fistHand.length === 21, `синтетическая кисть даёт 21 точку (${openHand.length})`);
  check(
    openHand.every((point) => point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1),
    'точки лежат в кадре 0..1',
  );
  check(pinchRatio(pinchHand) < PINCH_ENTER, `щипок опознан по отношению (${pinchRatio(pinchHand).toFixed(2)})`);
  check(pinchRatio(openHand) > PINCH_EXIT, `раскрытая кисть не щипок (${pinchRatio(openHand).toFixed(2)})`);
  check(
    pinchRatio(smallPinch) < PINCH_ENTER,
    `порог щипка не зависит от размера кисти (${pinchRatio(smallPinch).toFixed(2)})`,
  );
  check(classifyPose(fistHand, false) === 'fist', `классификация: кулак (${classifyPose(fistHand, false)})`);
  check(classifyPose(openHand, false) === 'open', `классификация: ладонь (${classifyPose(openHand, false)})`);
  check(classifyPose(pinchHand, true) === 'pinch', 'классификация: щипок');
  check(
    classifyPose(thumbsHand, false) === 'thumbsUp',
    `классификация: большой палец вверх (${classifyPose(thumbsHand, false)})`,
  );

  console.log('Жесты: контроллер (кадры распознавания 30 Гц + кадры рендера 60 Гц)');
  const seen: string[] = [];
  const controller = new GestureController({ mirror: false, sensitivity: 1.2, smoothing: 0.5, pauseGesture: true });
  for (const name of ['swipe-left', 'swipe-right', 'palm-pause', 'fist-reset', 'thumbs-up', 'hand-lost'] as const) {
    controller.on(name, () => seen.push(name));
  }

  const step = 1 / 60;
  const frame = (landmarks: Landmark[], time: number): HandFrame => ({
    hands: [{ landmarks, handedness: 'Right', score: 0.95 }],
    timestampMs: time * 1000,
    inferenceMs: 3,
  });

  let clock = 0;
  const run = (landmarks: Landmark[], frames: number): void => {
    for (let i = 0; i < frames; i++) {
      clock += step;
      if (i % 2 === 0) controller.push(frame(landmarks, clock));
      controller.update(step);
    }
  };

  run(openHand, 40);
  check(controller.state.cursor.active, 'курсор руки активен после потока кадров');
  check(
    Math.abs(controller.state.cursor.ndcX) <= 1.15 && Math.abs(controller.state.cursor.ndcY) <= 1.15,
    `курсор в пределах NDC (${controller.state.cursor.ndcX.toFixed(2)}; ${controller.state.cursor.ndcY.toFixed(2)})`,
  );

  run(pinchHand, 30);
  check(controller.state.pinch.active, 'щипок включился (гистерезис входа)');
  check(controller.state.pose === 'pinch', `поза щипка видна сценам (${controller.state.pose})`);
  controller.setGrabbed(true);
  check(controller.state.grabbed, 'сцена может сообщить о захвате объекта щипком');
  controller.setGrabbed(false);

  run(openHand, 30);
  check(!controller.state.pinch.active, 'щипок выключился после раскрытия пальцев');

  // Свайп: сначала медленно подводим ладонь к левому краю (скорость ниже порога —
  // это не свайп), даём фильтру успокоиться и только потом делаем быстрый мах вправо.
  const leftHand = makeSyntheticHand({ centerX: 0.22, centerY: 0.5, size: 0.22, openness: 1 });
  for (let i = 1; i <= 40; i++) {
    clock += step;
    const x = 0.5 - (i / 40) * 0.28;
    controller.push(frame(makeSyntheticHand({ centerX: x, centerY: 0.5, size: 0.22, openness: 1 }), clock));
    controller.update(step);
  }
  // Пауза в той же точке: гасим инерцию фильтра и кулдауны — мах должен считаться «с нуля».
  run(leftHand, 70);
  seen.length = 0;
  for (let i = 0; i <= 12; i++) {
    clock += step;
    const x = 0.22 + (i / 12) * 0.7;
    controller.push(frame(makeSyntheticHand({ centerX: x, centerY: 0.5, size: 0.22, openness: 1 }), clock));
    controller.update(step);
  }
  check(seen.includes('swipe-right'), `свайп вправо распознан (${seen.join(', ') || 'нет событий'})`);

  // «Класс»: удержание большого пальца вверх около секунды.
  seen.length = 0;
  run(thumbsHand, 90);
  check(seen.includes('thumbs-up'), `«класс» по удержанию распознан (${seen.join(', ') || 'нет событий'})`);

  // Потеря руки: кадры прекращаются, курсор должен погаснуть.
  clock += 0.6;
  controller.update(0.6);
  check(!controller.state.cursor.active, 'без кадров курсор гаснет (hand-lost)');
  check(seen.includes('hand-lost'), 'сцена получает событие hand-lost');

  console.log('Жесты: демо-источник (превью без камеры)');
  const demo = new DemoHandSource();
  const demoFrames: HandFrame[] = [];
  const demoOff = demo.onFrame((item) => demoFrames.push(item));
  await demo.start();
  await wait(450);
  demo.stop();
  demoOff();
  check(demoFrames.length >= 6, `демо-рука выдаёт кадры ~30 Гц (${demoFrames.length} за 450 мс)`);
  check(
    demoFrames.every((item) => item.hands.length === 0 || item.hands[0].landmarks.length === 21),
    'в кадрах демо-руки по 21 точке',
  );

  console.log('Указатель: мышь и рука — один интерфейс для сцен');
  const hub = new PointerHub();
  const hubEvents: string[] = [];
  hub.onPress(() => hubEvents.push('press'));
  hub.onRelease(() => hubEvents.push('release'));
  hub.onClick(() => hubEvents.push('click'));
  hub.setHandPointer(-0.4, 0.3, true);
  check(hub.state.source === 'hand', 'источник указателя — рука');
  check(Math.abs(hub.state.ndcX + 0.4) < 1e-6, 'курсор руки доходит до сцен в NDC');
  hub.setHandPress(true);
  check(hub.state.pressed, 'щипок = нажатие указателя');
  hub.setHandPress(false);
  await wait(20);
  check(hubEvents.join(',') === 'press,release,click', `короткий щипок даёт клик по объекту (${hubEvents.join(', ')})`);
  hub.setHandPress(true);
  await wait(760);
  hub.setHandPress(false);
  check(!hubEvents.slice(3).includes('click'), 'долгий щипок — это перетаскивание, а не клик');
  hub.clearHand();
  check(!hub.state.active && hub.state.source === null, 'рука ушла из кадра — указатель снят');

  console.log('Жесты: загрузка библиотеки MediaPipe (тег script → глобал Vision)');
  // Проверяем ровно тот механизм, из-за которого раньше падал dev-сервер: библиотека
  // подключается скриптом из public/ (или CDN), а не импортом пакета на этапе сборки.
  const bundleFile = join(process.cwd(), 'public', 'mediapipe', 'vision_bundle.js');
  if (!existsSync(bundleFile)) {
    console.log('  • пропущено: нет public/mediapipe/vision_bundle.js (нужен npm run sync:mediapipe)');
  } else {
    const dom = globalThis as unknown as { document?: unknown; Vision?: unknown };
    const realDocument = dom.document;
    const created: { listeners: Record<string, (() => void)[]>; dataset: Record<string, string> }[] = [];

    dom.document = {
      querySelector: () => null,
      createElement: () => {
        const script = {
          src: '',
          dataset: {} as Record<string, string>,
          listeners: {} as Record<string, (() => void)[]>,
          addEventListener(type: string, listener: () => void) {
            (this.listeners[type] ??= []).push(listener);
          },
          remove() {
            /* в заглушке удалять нечего */
          },
        };
        created.push(script);
        return script;
      },
      head: {
        appendChild: (script: { src: string; listeners: Record<string, (() => void)[]> }) => {
          // Вместо сети выполняем настоящий бандл из public/: он объявляет глобал `Vision`.
          const file = join(process.cwd(), 'public', script.src.replace(/^\//, ''));
          if (!existsSync(file)) throw new Error(`нет файла ${file}`);
          runInThisContext(readFileSync(file, 'utf8'));
          setTimeout(() => (script.listeners.load ?? []).forEach((listener) => listener()), 0);
        },
      },
    };

    try {
      const library = await loadMediaPipe();
      check(
        typeof library.HandLandmarker.createFromOptions === 'function' &&
          typeof library.FilesetResolver.forVisionTasks === 'function',
        'библиотека MediaPipe подключилась из локальной копии и найдена на глобале Vision',
      );
      check(created[0]?.src === '/mediapipe/vision_bundle.js', `первым берётся локальный путь (${created[0]?.src})`);
    } finally {
      dom.document = realDocument;
      // `var Vision` в глобальном контексте — неперезаписываемое свойство: просто обнуляем.
      dom.Vision = undefined;
    }
  }

  console.log('Жесты: распознавание контейнера модели (.task)');
  // Настоящая модель начинается двумя нулевыми байтами перед ZIP-сигнатурой:
  //   00 00 50 4b 03 04 …
  // Строгая проверка «PK в первых двух байтах» отвергала валидный файл — теперь заголовок
  // ищется в первых 64 байтах, плюс проверяется запись конца каталога в хвосте.
  const modelOnDisk = join(process.cwd(), 'public', 'models', 'hand_landmarker.task');
  if (existsSync(modelOnDisk)) {
    const bytes = new Uint8Array(readFileSync(modelOnDisk));
    check(looksLikeTaskFile(bytes), `скачанная модель принимается (${(bytes.length / 1024 ** 2).toFixed(1)} МБ)`);
    check(
      bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0x50 && bytes[3] === 0x4b,
      'подтверждено: у модели два нулевых байта перед ZIP-заголовком',
    );
  } else {
    console.log('  • пропущено: public/models/hand_landmarker.task не скачана (npm run fetch:models)');
  }

  const fakeTask = new Uint8Array(200_000);
  fakeTask.set([0x00, 0x00, 0x50, 0x4b, 0x03, 0x04]);
  fakeTask.set([0x50, 0x4b, 0x05, 0x06], fakeTask.length - 4);
  check(looksLikeTaskFile(fakeTask), 'файл с заголовком ZIP и концом каталога принимается');
  check(!looksLikeTaskFile(new Uint8Array(200_000)), 'нули без ZIP-заголовка отвергаются');
  check(!looksLikeTaskFile(fakeTask.subarray(0, 50_000)), 'слишком маленький файл отвергается');
  const htmlStub = new TextEncoder().encode(
    '<!doctype html><html><body>index.html</body></html>' + ' '.repeat(200_000),
  );
  check(!looksLikeTaskFile(htmlStub), 'HTML-заглушка dev-сервера отвергается');
  check(
    MODEL_SOURCES[0] === '/models/hand_landmarker.task' && MODEL_SOURCES.length >= 3,
    `локальный путь — первый источник, зеркал не меньше двух (${MODEL_SOURCES.length})`,
  );

  console.log(failures === 0 ? '\nВсе проверки пройдены ✅' : `\nПровалено проверок: ${failures} ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
