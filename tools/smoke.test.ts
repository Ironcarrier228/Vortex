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
import { economyRate } from '../src/core/gesture/rate';
import { frameInfo, hintForStatus, pinchText } from '../src/core/gesture';
import { CameraStepError, describeError, isTransientCameraError } from '../src/core/gesture/handTracker';
import * as THREE from 'three';
import {
  ForceGraph,
  HOLE_EJECT_SPEED,
  HOLE_STRETCH_EXPLODE,
  HOLE_STRETCH_VOID,
  holeOutcome,
  holeOutcomeLabel,
} from '../src/scenes/network/graph';
import { HOLE_STRETCH_MAX } from '../src/scenes/network/blackHole';
import { DEFAULT_PREFS } from '../src/core/prefs';
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
  const controller = new GestureController({
    mirror: false,
    sensitivity: 1.2,
    smoothing: 0.5,
    // Свайпы и пауза по умолчанию выключены (срабатывали случайно) — в тесте включаем,
    // чтобы проверить сами детекторы, которые остались в контроллере.
    pauseGesture: true,
    swipes: true,
    fistReset: true,
  });
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

  console.log('Сеть: узел «вырвать — покрутить — оставить»');
  const inspectGraph = new ForceGraph();
  const inspectConnections: NetConnection[] = Array.from({ length: 12 }, (_, index) => ({
    id: `tcp:${index}`,
    protocol: 'tcp',
    state: 'ESTABLISHED',
    pid: 4200 + index,
    process: index < 6 ? 'svchost' : 'node',
    local: { ip: '192.168.0.10', port: 50_000 + index },
    remote: { ip: `93.184.216.${index}`, port: 443, host: `host-${index}` },
  }) as NetConnection);
  inspectGraph.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) inspectGraph.update(1 / 60, frame / 60, null);

  const pulled = inspectGraph.nodes.find((node) => node.kind === 'process')!;
  check(Boolean(pulled), `в графе есть узел-процесс (${pulled?.label})`);

  // «Вырвать»: узел закрепляется и раздувается для осмотра.
  inspectGraph.beginDrag(pulled);
  inspectGraph.setBoost(pulled, 1);
  for (let frame = 0; frame < 40; frame++) inspectGraph.update(1 / 60, frame / 60, null);
  check(pulled.fx !== null && pulled.fx !== undefined, 'вырванный узел закреплён (физика его не тянет)');
  check((pulled.boost ?? 0) > 0.85, `узел раздулся для осмотра (boost ${(pulled.boost ?? 0).toFixed(2)})`);

  // «Покрутить»: поворот кисти накапливается.
  inspectGraph.spinBy(pulled, 1.2);
  inspectGraph.spinBy(pulled, 0.8);
  check(Math.abs((pulled.spin ?? 0) - 2) < 1e-6, `поворот накопился (${(pulled.spin ?? 0).toFixed(2)} рад)`);

  // «Оставить»: узел возвращается к обычному размеру, но остаётся закреплённым там, где его отпустили.
  const leftAt = { x: pulled.x, y: pulled.y, z: pulled.z };
  inspectGraph.endDrag(true);
  inspectGraph.setBoost(pulled, 0);
  for (let frame = 0; frame < 90; frame++) inspectGraph.update(1 / 60, frame / 60, null);
  check((pulled.boost ?? 0) < 0.05, `после отпускания узел вернулся к обычному размеру (${(pulled.boost ?? 0).toFixed(2)})`);
  const drift = Math.hypot((pulled.x ?? 0) - (leftAt.x ?? 0), (pulled.y ?? 0) - (leftAt.y ?? 0), (pulled.z ?? 0) - (leftAt.z ?? 0));
  check(drift < 0.5, `узел остался там, где его оставили (сдвиг ${drift.toFixed(2)})`);
  check(pulled.fx !== null && pulled.fx !== undefined, 'узел остаётся вырванным из цепочки');

  // «Вернуть узлы»: закрепления и раздувание снимаются.
  inspectGraph.unpinAll();
  check(pulled.fx === null && pulled.fy === null && pulled.fz === null, 'кнопка «Вернуть узлы» снимает закрепление');
  check((pulled.spin ?? 0) === 0 && (pulled.boostTarget ?? 0) === 0, 'поворот и раздувание сброшены');
  for (let frame = 0; frame < 120; frame++) inspectGraph.update(1 / 60, frame / 60, null);
  const moved = inspectGraph.nodes.some((node) => node.kind !== 'local' && node.fx !== null && node.fx !== undefined);
  check(!moved, 'после возврата ни один узел не закреплён');
  inspectGraph.dispose();

  console.log('Сеть: подключения вырванного орба забирает сосед');
  const rubberGraph = new ForceGraph();
  rubberGraph.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) rubberGraph.update(1 / 60, frame / 60, null);

  const centre = rubberGraph.nodes.find((node) => node.kind === 'process')!;
  const attached = rubberGraph.links.filter((link) => link.source === centre || link.target === centre);
  check(attached.length > 0, `у узла «${centre.label}» есть соединения (${attached.length})`);

  rubberGraph.beginDrag(centre);
  rubberGraph.setBoost(centre, 1);
  for (let frame = 0; frame < 20; frame++) rubberGraph.update(1 / 60, frame / 60, null);

  // Уводим узел далеко от его текущего места: точка крепления остаётся позади (вялая резинка).
  const away = new THREE.Vector3((centre.x ?? 0) + 60, (centre.y ?? 0) + 40, (centre.z ?? 0) + 30);
  rubberGraph.moveDragged(away);
  rubberGraph.update(1 / 60, 0.5, null);
  const lag = Math.hypot(
    (attached[0].rab?.x ?? away.x) - away.x,
    (attached[0].rab?.y ?? away.y) - away.y,
    (attached[0].rab?.z ?? away.z) - away.z,
  );
  check(lag > 5, `соединения отстают от узла — линия тянется (отставание ${lag.toFixed(1)})`);

  // Отпустили рано (линия ещё не всосалась): соединения выкатываются обратно к узлу.
  rubberGraph.setBoost(centre, 0);
  rubberGraph.endDrag(true, centre);
  for (let frame = 0; frame < 30; frame++) rubberGraph.update(1 / 60, 1.2 + frame / 60, null);
  check(attached.every((link) => (link.absorb ?? 0) === 0), 'отпустили рано — линии выкатились обратно');
  check(attached.every((link) => rubberGraph.links.includes(link)), 'связи на месте, пока их не вырвали до конца');

  // Держим долго: линия всосалась — подключения орба забирает сосед.
  rubberGraph.beginDrag(centre);
  rubberGraph.setBoost(centre, 1);
  rubberGraph.moveDragged(away);
  for (let frame = 0; frame < 200; frame++) rubberGraph.update(1 / 60, 2 + frame / 60, null);
  check(rubberGraph.takeoverCount > 0, `подключения перешли соседу (наследников: ${rubberGraph.takeoverCount})`);
  check(
    attached
      .filter((link) => link.kind === 'process-remote')
      .every((link) => link.flowFrom !== undefined),
    'у перешедших связей виден перелёт к соседу (flowFrom)',
  );
  check(
    rubberGraph.links.every((link) => link.source !== centre && link.target !== centre),
    'у вырванного орба не осталось ни одной связи',
  );
  check(rubberGraph.nodes.includes(centre), 'сам вырванный орб остался в сцене');
  check(
    attached.some((link) => rubberGraph.links.includes(link)),
    'линии не исчезли: их подхватил соседний орб',
  );
  check(
    !rubberGraph.links.some(
      (link) => link.kind === 'local-process' && (link.source === centre || link.target === centre),
    ),
    'связь «машина ↔ процесс» ушла (у соседа такая связь уже есть)',
  );

  // Новый снимок сети не возвращает связи обратно вырванному орбу — их владелец сменился.
  rubberGraph.sync(inspectConnections);
  check(
    rubberGraph.links.filter((link) => link.source === centre || link.target === centre).length === 0,
    'связи остаются у соседа и после нового снимка',
  );
  rubberGraph.unpinAll();
  rubberGraph.sync(inspectConnections);
  const restored = rubberGraph.links.filter((link) => link.source === centre || link.target === centre);
  check(restored.length === attached.length, `«Вернуть узлы» вернула связи орбу (${restored.length})`);
  check(rubberGraph.takeoverCount === 0, 'подстановки соседей сброшены');
  rubberGraph.dispose();

  console.log('Сеть: чёрная дыра — выбросить орб руками');
  const holeGraph = new ForceGraph();
  holeGraph.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) holeGraph.update(1 / 60, frame / 60, null);
  check(holeGraph.hole.object.children.length >= 6, `дыра собрана из деталей (${holeGraph.hole.object.children.length})`);
  check(!holeGraph.hole.alive, 'чёрная дыра закрыта, пока никто ничего не выбрасывал');

  const localNode = holeGraph.nodes.find((node) => node.kind === 'local')!;
  const velocity = new THREE.Vector3(90, 20, -40);
  check(!holeGraph.throwNode(localNode, velocity), 'саму машину выбросить нельзя');

  const orb = holeGraph.nodes.find((node) => node.kind === 'remote')!;
  const orbLinks = holeGraph.links.filter((link) => link.source === orb || link.target === orb);
  check(orbLinks.length > 0, `у хоста «${orb.label}» есть связи (${orbLinks.length})`);

  check(holeGraph.throwNode(orb, velocity), 'бросок принят: орб улетает');
  check(holeGraph.hole.alive, 'чёрная дыра раскрылась на броске');
  const holeDistance = (): number =>
    Math.hypot(
      (orb.x ?? 0) - holeGraph.hole.position.x,
      (orb.y ?? 0) - holeGraph.hole.position.y,
      (orb.z ?? 0) - holeGraph.hole.position.z,
    );
  const distanceAtThrow = holeDistance();
  for (let frame = 0; frame < 30; frame++) holeGraph.update(1 / 60, 1 + frame / 60, null);
  check(holeDistance() < distanceAtThrow, `орб затягивает: ${distanceAtThrow.toFixed(0)} → ${holeDistance().toFixed(0)}`);
  check(holeGraph.hole.radius > 1, `дыра набрала размер (${holeGraph.hole.radius.toFixed(1)})`);

  for (let frame = 0; frame < 400 && holeGraph.nodes.includes(orb); frame++) {
    holeGraph.update(1 / 60, 1.5 + frame / 60, null);
  }
  check(!holeGraph.nodes.includes(orb), 'орб проглочен: узел исчез из графа');
  check(holeGraph.devoured === 1, `панель сцены видит поглощение (${holeGraph.devoured})`);
  check(holeGraph.dumpCount === 1, 'орб лежит в чёрной дыре и может быть вытащен');
  check(holeGraph.takeoverCount === 1, 'подключение выкинутого орба забрал соседний орб');
  check(
    orbLinks.every((link) => link.source !== orb && link.target !== orb),
    'подключения выкинутого орба больше не висят на нём',
  );
  check(orbLinks.every((link) => holeGraph.links.includes(link)), 'линия не оборвалась: её подхватил сосед');

  // Дыра не исчезает: она оседает и ждёт, когда в неё засунут руку.
  for (let frame = 0; frame < 200; frame++) holeGraph.update(1 / 60, 9 + frame / 60, null);
  check(holeGraph.hole.alive && !holeGraph.hole.held, 'дыра осела, но осталась в сцене');
  check(holeGraph.hole.radius < 3, `осевшая дыра стала маленькой (${holeGraph.hole.radius.toFixed(2)})`);

  // Руку в дыру: она раскрывается и отдаёт орб обратно.
  check(holeGraph.grabHole(), 'дыру можно взять рукой');
  check(holeGraph.hole.held, 'взятая дыра раскрылась');
  const pulledOut = holeGraph.extractOrb();
  check(Boolean(pulledOut) && pulledOut === orb, `из дыры вылез тот самый орб («${pulledOut?.label}»)`);
  check(holeGraph.dumpCount === 0 && holeGraph.devoured === 0, 'дыра опустела');
  for (let frame = 0; frame < 200; frame++) holeGraph.update(1 / 60, 12 + frame / 60, null);
  check(!holeGraph.hole.alive, 'пустая дыра схлопнулась и исчезла');
  holeGraph.sync(inspectConnections);
  check(
    holeGraph.nodes.some((node) => node.id === orb.id),
    'вытащенный орб снова в графе',
  );
  const backLinks = holeGraph.links.filter((link) => link.source === orb || link.target === orb);
  check(backLinks.length === orbLinks.length, `связи вернулись к вытащенному орбу (${backLinks.length})`);

  // Второй заход: выкинули ещё один орб — и вернули всё разом кнопкой «Вернуть узлы».
  const second = holeGraph.nodes.find((node) => node.kind === 'remote' && node !== orb)!;
  holeGraph.throwNode(second, new THREE.Vector3(-80, -30, 20));
  for (let frame = 0; frame < 600 && holeGraph.nodes.includes(second); frame++) {
    holeGraph.update(1 / 60, 30 + frame / 60, null);
  }
  check(!holeGraph.nodes.includes(second), 'второй орб тоже проглочен');
  holeGraph.sync(inspectConnections);
  check(!holeGraph.nodes.includes(second), 'новый снимок сети не возвращает проглоченный орб');
  holeGraph.unpinAll();
  holeGraph.sync(inspectConnections);
  check(holeGraph.nodes.some((node) => node.id === second.id), '«Вернуть узлы» оживила проглоченный орб');
  for (let frame = 0; frame < 200; frame++) holeGraph.update(1 / 60, 40 + frame / 60, null);
  check(holeGraph.dumpCount === 0 && !holeGraph.hole.alive, 'после возврата дыра пуста и закрыта');

  // Две руки: каждый щипок держит свой орб.
  const twoHands = holeGraph.nodes.filter((node) => node.kind !== 'local').slice(0, 2);
  holeGraph.beginDrag(twoHands[0]);
  holeGraph.beginDrag(twoHands[1]);
  check(holeGraph.grabbedCount === 2, `двумя руками держим два орба (${holeGraph.grabbedCount})`);
  holeGraph.endDrag(true, twoHands[0]);
  check(
    holeGraph.grabbedCount === 1 && holeGraph.dragged === twoHands[1],
    'отпустили один орб — второй остался в руке',
  );
  holeGraph.endDrag(true, twoHands[1]);
  check(holeGraph.grabbedCount === 0, 'обе руки свободны');

  // ── Передача подключений: с одного орба на другой и наоборот ──
  console.log('Сеть: подключения передаются орб → орб (и наоборот)');
  const wire = new ForceGraph();
  wire.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) wire.update(1 / 60, frame / 60, null);

  const donor = wire.nodes.find((node) => node.kind === 'process' && node.label === 'svchost')!;
  const receiver = wire.nodes.find((node) => node.kind === 'process' && node.label === 'node')!;
  const donorLinks = wire.links.filter((link) => link.source === donor || link.target === donor);
  const receiverLinks = wire.links.filter((link) => link.source === receiver || link.target === receiver);
  check(donorLinks.length === 7 && receiverLinks.length === 7, `у обоих процессов по 7 связей`);

  const handOff = wire.rewire(donor, receiver);
  check(Boolean(handOff) && handOff?.moved === 6, `подключения перешли другому орбу (${handOff?.moved})`);
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === donor || link.target === donor)).length === 0,
    'у отдавшего орба не осталось подключений',
  );
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === receiver || link.target === receiver)).length === 12,
    'у принявшего орба стало вдвое больше подключений',
  );
  check(
    wire.links.filter((link) => link.kind === 'local-process' && (link.source === donor || link.target === donor)).length === 1,
    'связь «машина ↔ процесс» осталась у процесса',
  );
  check(wire.holderOf(donor) === receiver, 'граф знает, кто держит подключения отдавшего');
  check(wire.holderOf(receiver) === undefined, 'принявший владеет подключениями сам');
  check(wire.connectionsOf(donor).length === 0 && wire.connectionsOf(receiver).length === 12, 'панель видит линии по графу');

  // Снимок сети не возвращает подключения обратно: владелец запомнен.
  for (let frame = 0; frame < 40; frame++) wire.update(1 / 60, 3 + frame / 60, null);
  wire.sync(inspectConnections);
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === donor || link.target === donor)).length === 0,
    'новый снимок сети не отменяет передачу',
  );
  check(wire.nodes.includes(donor), 'отдавший орб остался в сцене');

  // «Обратно»: подключения возвращаются прежнему орбу.
  check(wire.undoRewire(), 'передача отменяется');
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === donor || link.target === donor)).length === 6,
    'подключения вернулись к прежнему орбу',
  );
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === receiver || link.target === receiver)).length === 6,
    'и у второго орба снова свои шесть',
  );
  check(wire.holderOf(donor) === undefined && wire.rewireCount === 0, 'владельцы вернулись в исходное');

  // Та же передача, но в другую сторону: перетащили приёмник на отдающего.
  const back = wire.rewire(receiver, donor);
  check(Boolean(back) && back?.moved === 6, `подключения node перешли svchost (${back?.moved})`);
  check(wire.holderOf(receiver) === donor && wire.rewireCount === 1, 'направление обратное — владелец другой орб');
  wire.sync(inspectConnections);
  check(
    wire.links.filter((link) => link.kind === 'process-remote' && (link.source === receiver || link.target === receiver)).length === 0,
    'обратная передача тоже держится снимком сети',
  );

  // Дыра и передача: у орба в дыре подключения забирает сосед, а не теряются.
  check(wire.undoRewire(), 'вторая передача тоже отменяется');
  wire.unpinAll();
  wire.sync(inspectConnections);
  check(wire.links.filter((link) => link.source === donor || link.target === donor).length === 7, 'после «Вернуть узлы» всё как было');

  // Режим передачи: сначала выбираем отдающего (подсветка + кандидаты), затем приёмника.
  check(wire.sourceMark === null && wire.dropTarget === null, 'вне режима ничего не подсвечено');
  wire.setSourceMark(receiver);
  wire.setCandidates([donor]);
  check(wire.sourceMark === receiver, 'отдающий орб помечен');
  wire.setCandidates(null);
  wire.setSourceMark(null);
  check(wire.sourceMark === null, 'пометка снимается (выход из режима)');
  wire.dispose();

  // Режим «в два щелчка» работает и без перетаскивания: A отдаёт, B принимает, и наоборот.
  const click = new ForceGraph();
  click.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) click.update(1 / 60, frame / 60, null);
  const first = click.nodes.find((node) => node.kind === 'process' && node.label === 'svchost')!;
  const secondOrb = click.nodes.find((node) => node.kind === 'process' && node.label === 'node')!;
  const candidates = click.nodes.filter((node) => node !== first && click.canRewire(first, node));
  check(candidates.includes(secondOrb), 'приёмники видны заранее — есть куда целиться щипком');
  const pick = click.rewire(first, secondOrb);
  check(Boolean(pick) && pick?.moved === 6, `двумя щелчками подключения перешли приёмнику (${pick?.moved})`);
  check(click.holderOf(first) === secondOrb, 'граф помнит, кто теперь держит подключения');
  const back2 = click.rewire(secondOrb, first);
  check(Boolean(back2) && back2?.moved === 12, `обратно перешло всё, что было на приёмнике (${back2?.moved})`);
  check(click.holderOf(secondOrb) === first, 'и владелец снова первый орб');
  click.unpinAll();
  click.sync(inspectConnections);
  check(
    click.links.filter((link) => link.kind === 'process-remote' && (link.source === first || link.target === first)).length === 6,
    '«Вернуть узлы» после ручных передач восстанавливает исходные связи',
  );
  click.dispose();

  const wireTail = new ForceGraph();
  wireTail.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) wireTail.update(1 / 60, frame / 60, null);

  // Орбы разных типов подключениями не меняются, «эту машину» не выбирают.
  const donor2 = wireTail.nodes.find((node) => node.kind === 'process' && node.label === 'svchost')!;
  const receiver2 = wireTail.nodes.find((node) => node.kind === 'process' && node.label === 'node')!;
  const host = wireTail.nodes.find((node) => node.kind === 'remote')!;
  const machine = wireTail.nodes.find((node) => node.kind === 'local')!;
  check(!wireTail.canRewire(donor2, host), 'процесс и хост подключениями не меняются');
  check(!wireTail.canRewire(donor2, machine), '«эту машину» в приёмники не берём');
  check(!wireTail.canRewire(donor2, donor2), 'сам с собой орб не меняется');
  check(wireTail.canRewire(donor2, receiver2), 'два процесса — можно');
  check(wireTail.rewire(donor2, host) === null, 'передача между разными типами отменяется');
  check(wireTail.rewire(machine, donor2) === null, 'у «этой машины» подключения забрать нельзя');

  // Хост ↔ хост: подключения хоста переезжают другому хосту — тоже работает.
  const hostWire = new ForceGraph();
  hostWire.sync(inspectConnections);
  for (let frame = 0; frame < 120; frame++) hostWire.update(1 / 60, frame / 60, null);
  const hostA = hostWire.nodes.find((node) => node.kind === 'remote' && node.label === 'host-0')!;
  const hostB = hostWire.nodes.find((node) => node.kind === 'remote' && node.label === 'host-1')!;
  const hostMove = hostWire.rewire(hostA, hostB);
  check(Boolean(hostMove) && hostMove?.moved === 1, `хост тоже может отдать подключение хосту (${hostMove?.moved})`);
  check(hostWire.holderOf(hostA) === hostB, 'хост знает, кто держит его подключение');
  hostWire.undoRewire();
  check(hostWire.holderOf(hostA) === undefined, 'и получает его обратно по «Обратно»');
  hostWire.dispose();

  // Чёрная дыра: по ней видно, куда бросить орб (проверяем на камере).
  const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 900);
  camera.position.set(0, 0, 96);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const holeView = new ForceGraph();
  holeView.sync(inspectConnections);
  const throwMe = holeView.nodes.find((node) => node.kind === 'remote')!;
  holeView.throwNode(throwMe, new THREE.Vector3(0, 0, -60));
  for (let frame = 0; frame < 600 && holeView.nodes.includes(throwMe); frame++) {
    holeView.update(1 / 60, frame / 60, null, camera);
  }
  const holeCentre = new THREE.Vector3()
    .copy(holeView.hole.object.position)
    .applyMatrix4(holeView.object.matrixWorld)
    .project(camera);
  check(
    holeView.hitHole(camera, holeCentre.x, holeCentre.y),
    'видимую дыру можно навести и бросить в неё орб (попадание по центру)',
  );
  check(!holeView.hitHole(camera, holeCentre.x + 0.6, holeCentre.y), 'мимо дыры — промах');
  holeView.dispose();

  // Приёмник подсвечивается — сцена видит, куда перейдут подключения.
  wireTail.setDropTarget(receiver2);
  check(wireTail.dropTarget === receiver2, 'орб-приёмник подсвечен');
  wireTail.setDropTarget(null);
  check(wireTail.dropTarget === null, 'подсветка снимается');
  wireTail.dispose();

  // ── Масштаб сцены: «сложить всю сцену в ладонь» — это не зум камеры ──
  const sample = holeGraph.nodes[0];
  const worldBefore = holeGraph.nodeWorld(sample).clone();
  holeGraph.setGlobalScale(0.25);
  check(Math.abs(holeGraph.globalScale - 0.25) < 1e-6, 'сцена сжалась до 25%');
  const worldAfter = holeGraph.nodeWorld(sample);
  check(
    Math.abs(worldAfter.x - worldBefore.x * 0.25) < 1e-6 && Math.abs(worldAfter.y - worldBefore.y * 0.25) < 1e-6,
    'масштаб применяется к содержимому сцены (координаты узлов сжались)',
  );
  check(holeGraph.collapsed, 'сцена помечена как свёрнутая — можно «уместить в ладони»');
  const palm = new THREE.Vector3(12, 6, -4);
  holeGraph.setAnchor(palm);
  for (let frame = 0; frame < 200; frame++) holeGraph.update(1 / 60, 40 + frame / 60, null);
  const shifted = holeGraph.nodeWorld(sample);
  // Физика за это время тоже двигала узлы, поэтому сравниваем с их текущими координатами.
  check(
    Math.abs(shifted.x - ((sample.x ?? 0) * holeGraph.globalScale + palm.x)) < 0.6 &&
      Math.abs(shifted.y - ((sample.y ?? 0) * holeGraph.globalScale + palm.y)) < 0.6,
    'свёрнутая сцена подъехала к точке ладони (якорь)',
  );
  holeGraph.setAnchor(null);
  holeGraph.setGlobalScale(1);
  for (let frame = 0; frame < 200; frame++) holeGraph.update(1 / 60, 45 + frame / 60, null);
  check(Math.abs(holeGraph.nodeWorld(sample).x - (sample.x ?? 0)) < 0.6, 'развёрнутая сцена вернулась в центр');
  holeGraph.dispose();

  console.log('Жесты: калибровка щипка под конкретную руку');
  // «Далёкая или шумная» рука: раскрытая кисть даёт отношение ~1.0, а неглубокий щипок — 0.46.
  // Фиксированный порог 0.42 такой щипок не ловил вовсе — отсюда «щипок не робит». Калибровка
  // считает порог относительно раскрытой кисти этой конкретной руки.
  const farOpen = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.1, openness: 1, thumbSpread: 2.2 });
  const farHalfPinch = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.1, pinch: 0.4, thumbSpread: 2.2 });
  const shallowRatio = pinchRatio(farHalfPinch);
  check(
    shallowRatio > PINCH_ENTER,
    `неглубокий щипок даёт ${shallowRatio.toFixed(2)} — фиксированный порог ${PINCH_ENTER} его не поймал бы`,
  );

  const calibrated = new GestureController({
    mirror: false,
    sensitivity: 1.2,
    smoothing: 0.5,
    pauseGesture: false,
    swipes: false,
    fistReset: false,
  });
  let calClock = 0;
  const calRun = (landmarks: Landmark[], frames: number): void => {
    for (let i = 0; i < frames; i++) {
      calClock += step;
      if (i % 2 === 0) {
        calibrated.push({ hands: [{ landmarks, handedness: 'Right', score: 0.95 }], timestampMs: calClock * 1000, inferenceMs: 3 });
      }
      calibrated.update(step);
    }
  };

  calRun(farOpen, 60);
  check(!calibrated.state.pinch.active, 'раскрытая рука не считается щипком');
  check(
    calibrated.state.pinch.enter > PINCH_ENTER,
    `порог подстроился под руку: ${calibrated.state.pinch.enter.toFixed(2)} > ${PINCH_ENTER}`,
  );

  calRun(farHalfPinch, 40);
  check(calibrated.state.pinch.active, `неглубокий щипок распознан (отношение ${shallowRatio.toFixed(2)})`);

  calRun(farOpen, 40);
  check(!calibrated.state.pinch.active, 'после раскрытия пальцев щипок отпускается');

  const pinchInfo = pinchText(calibrated.state, { phase: 'running' });
  check(
    pinchInfo.includes('щипок') && /\d\.\d\d/.test(pinchInfo),
    `диагностика щипка показывает цифры: «${pinchInfo}»`,
  );

  console.log('Жесты: поведение по умолчанию (без случайных пауз и перелистывания)');
  const quiet = new GestureController({
    mirror: false,
    sensitivity: 1.2,
    smoothing: 0.5,
    pauseGesture: false,
    swipes: false,
    fistReset: false,
  });
  const quietEvents: string[] = [];
  for (const name of ['swipe-left', 'swipe-right', 'palm-pause', 'fist-reset', 'thumbs-up'] as const) {
    quiet.on(name, () => quietEvents.push(name));
  }

  let quietClock = 0;
  const quietRun = (landmarks: Landmark[], frames: number): void => {
    for (let i = 0; i < frames; i++) {
      quietClock += step;
      if (i % 2 === 0) {
        quiet.push({ hands: [{ landmarks, handedness: 'Right', score: 0.95 }], timestampMs: quietClock * 1000, inferenceMs: 3 });
      }
      quiet.update(step);
    }
  };

  // Ладонь держим долго: раньше это ставило визуализацию на паузу.
  quietRun(openHand, 120);
  check(!quietEvents.includes('palm-pause'), 'ладонь больше не ставит паузу');

  // Быстрый мах ладонью: раньше это переключало сцену.
  for (let i = 0; i <= 12; i++) {
    quietClock += step;
    quiet.push({
      hands: [{ landmarks: makeSyntheticHand({ centerX: 0.22 + (i / 12) * 0.7, centerY: 0.5, size: 0.22, openness: 1 }), handedness: 'Right', score: 0.95 }],
      timestampMs: quietClock * 1000,
      inferenceMs: 3,
    });
    quiet.update(step);
  }
  check(
    !quietEvents.includes('swipe-left') && !quietEvents.includes('swipe-right'),
    `мах ладонью больше не листает сцены (${quietEvents.join(', ') || 'событий нет'})`,
  );

  // Кулак: раньше сбрасывал расстановку узлов.
  quietRun(fistHand, 120);
  check(!quietEvents.includes('fist-reset'), 'кулак больше не сбрасывает раскладку');

  // «Класс» остаётся: это осознанный жест.
  quietRun(thumbsHand, 90);
  check(quietEvents.includes('thumbs-up'), '«класс» продолжает работать (действие сцены)');

  // Поворот кисти: им сцена вращает «вырванный» узел.
  const rolled = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, openness: 1, rotation: 0 });
  const rolledRight = makeSyntheticHand({ centerX: 0.5, centerY: 0.5, size: 0.22, openness: 1, rotation: Math.PI / 3 });
  quietRun(rolled, 30);
  const rollBefore = quiet.state.roll;
  for (let i = 0; i < 30; i++) {
    quietClock += step;
    if (i % 2 === 0) {
      quiet.push({ hands: [{ landmarks: rolledRight, handedness: 'Right', score: 0.95 }], timestampMs: quietClock * 1000, inferenceMs: 3 });
    }
    quiet.update(step);
  }
  const rollAfter = quiet.state.roll;
  check(
    Math.abs(rollAfter - rollBefore) > 0.3,
    `поворот кисти доходит до сцены (${rollBefore.toFixed(2)} → ${rollAfter.toFixed(2)} рад)`,
  );

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

  console.log('Жесты: диагностика камеры (почему «рук нет»)');
  const cameraNotes = frameInfo({
    phase: 'running',
    device: 'HD WebCam 640×480',
    resolution: '640×480',
    frames: 42,
    darkness: 96,
  });
  check(
    cameraNotes.includes('640×480') && cameraNotes.includes('кадров 42') && cameraNotes.includes('яркость'),
    `превью показывает состояние камеры: «${cameraNotes}»`,
  );
  check(
    hintForStatus({ phase: 'running', frames: 0 })?.includes('кадры') === true,
    'ноль кадров — подсказка про камеру, а не про положение руки',
  );
  check(
    hintForStatus({ phase: 'running', frames: 40, darkness: 5 })?.includes('чёрный') === true,
    'тёмный кадр — подсказка про свет и объектив',
  );
  check(
    hintForStatus({ phase: 'running', frames: 40, darkness: 120 })?.includes('40–80') === true,
    'живой кадр без руки — подсказка про расстояние до камеры',
  );
  check(
    hintForStatus({ phase: 'error', message: 'камера занята' })?.includes('Демо-рука') === true,
    'ошибка камеры — предлагаем демо-руку',
  );
  check(
    hintForStatus({ phase: 'starting-camera' })?.includes('Демо') === true,
    'пока камера поднимается, подсказка говорит про демо-режим',
  );

  console.log('Жесты: ошибки камеры (AbortError и другие) — понятно, что делать');
  const abortRequest = new CameraStepError('request', new DOMException('запуск камеры отменён', 'AbortError'));
  const abortPlay = new CameraStepError('play', new DOMException('play() прерван', 'AbortError'));
  check(
    describeError(abortRequest).includes('занято') && describeError(abortRequest).includes('Повторить'),
    `AbortError при запросе объясняет причину и предлагает повтор: «${describeError(abortRequest)}»`,
  );
  check(
    describeError(abortPlay).includes('показ') && !describeError(abortPlay).includes('занято'),
    `AbortError при показе потока — отдельное сообщение: «${describeError(abortPlay)}»`,
  );
  check(
    describeError(new DOMException('нет доступа', 'NotAllowedError')).includes('разрешите'),
    'запрет доступа — понятный совет',
  );
  check(
    describeError(new DOMException('занята', 'NotReadableError')).includes('Повторить'),
    'занятое устройство — предлагаем повторить',
  );
  check(
    describeError(new DOMException('пусто', 'NotFoundError')).includes('не найдена'),
    'нет устройства — так и говорим',
  );
  check(
    describeError(new Error('браузерное окружение не даёт доступ к камере')) ===
      'браузерное окружение не даёт доступ к камере',
    'прочие ошибки не подменяются общими словами',
  );
  check(
    isTransientCameraError(new DOMException('', 'AbortError')) &&
      isTransientCameraError(new DOMException('', 'NotReadableError')) &&
      isTransientCameraError(new DOMException('', 'TrackStartError')),
    'AbortError/NotReadableError/TrackStartError считаются временными — их повторяем',
  );
  check(
    !isTransientCameraError(new DOMException('', 'NotAllowedError')) &&
      !isTransientCameraError(new DOMException('', 'NotFoundError')) &&
      !isTransientCameraError(new DOMException('', 'OverconstrainedError')),
    'запрет доступа и отсутствие камеры повторами не лечатся — не пытаемся',
  );

  // ── Растянутая чёрная дыра: три исхода ──
  console.log('Сеть: растянутая чёрная дыра — схлопнется, взорвётся или поглотит всё');
  // Пороги: слабо потянули — вернёт орбы, сильнее — взорвётся, на максимуме — поглотит всё.
  check(
    holeOutcome(1) === 'collapse' && holeOutcome(HOLE_STRETCH_EXPLODE - 0.01) === 'collapse',
    'слабое растяжение — дыра просто схлопнется и вернёт орбы',
  );
  check(
    holeOutcome(HOLE_STRETCH_EXPLODE) === 'explode' && holeOutcome(HOLE_STRETCH_VOID - 0.01) === 'explode',
    'среднее растяжение — дыра взорвётся',
  );
  check(
    holeOutcome(HOLE_STRETCH_VOID) === 'void' && holeOutcome(HOLE_STRETCH_VOID * 4) === 'void',
    'перетянутая дыра поглотит всё',
  );
  check(
    holeOutcome(HOLE_STRETCH_VOID, false) === 'explode',
    'с выключенным «поглотить всё» дальше взрыва дело не идёт — приложение не закрывается',
  );
  check(
    holeOutcomeLabel('collapse').includes('схлопнется') &&
      holeOutcomeLabel('explode').includes('взорв') &&
      holeOutcomeLabel('void').includes('поглотит'),
    'каждый исход называется человеческими словами',
  );
  check(
    DEFAULT_PREFS.holeVoid === true,
    'по умолчанию крайний исход разрешён (тумблер «поглотить всё» включён)',
  );

  // Растяжение живой дыры: она реально крупнее и не превышает максимум.
  const stretched = new ForceGraph();
  stretched.sync(inspectConnections);
  stretched.hole.open(new THREE.Vector3(0, 0, 0), 5);
  stretched.hole.hold(true);
  check(stretched.hole.held && stretched.hole.alive, 'дыру раскрыли, чтобы растянуть');
  for (let frame = 0; frame < 240; frame++) stretched.update(1 / 60, frame / 60, null);
  const calmRadius = stretched.hole.radius;
  stretched.hole.setStretch(2);
  check(Math.abs(stretched.hole.stretch - 2) < 1e-6, 'растяжение 2× применилось');
  for (let frame = 0; frame < 240; frame++) stretched.update(1 / 60, 5 + frame / 60, null);
  const wideRadius = stretched.hole.radius;
  check(
    wideRadius > calmRadius * 1.5,
    `растянутая дыра заметно крупнее (${wideRadius.toFixed(2)} против ${calmRadius.toFixed(2)})`,
  );
  stretched.hole.setStretch(HOLE_STRETCH_MAX + 5);
  check(stretched.hole.stretch === HOLE_STRETCH_MAX, 'растяжение ограничено максимумом');
  stretched.hole.setStretch(0.2);
  check(stretched.hole.stretch === 1, 'сжать дыру меньше обычного нельзя');

  // Растянутая дыра ест всё, что попало за горизонт событий.
  const eater = new ForceGraph();
  eater.sync(inspectConnections);
  eater.hole.open(new THREE.Vector3(0, 0, 0), 6);
  eater.hole.hold(true);
  const near = eater.nodes.filter(
    (node) => node.kind !== 'local' && Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) < 6,
  );
  if (near.length > 0) {
    const eatenNear = eater.absorbNearby(6);
    check(eatenNear.length === near.length, `растянутая дыра съела тех, кто был рядом (${eatenNear.length})`);
  } else {
    check(eater.absorbNearby(6).length === 0, 'рядом никого — есть некого');
  }
  const total = eater.nodes.filter((node) => node.kind !== 'local' && node.devour === undefined).length;
  const swallowed = eater.absorbEverything();
  check(swallowed >= total, `исход «поглотит всё»: за горизонт ушло ${swallowed} орбов`);
  check(
    eater.nodes.every((node) => node.kind === 'local' || node.devour !== undefined),
    'в сцене не осталось ни одного живого орба',
  );
  check(
    eater.nodes.some((node) => node.kind === 'local'),
    'машина остаётся на месте — это центр сцены',
  );

  // Взрыв: дыра выплюнула всех веером, и они остались там, где остановились.
  const inHole = eater.dumpCount;
  const blown = eater.ejectAll(HOLE_EJECT_SPEED);
  check(
    blown.length === inHole && inHole >= swallowed,
    `взрыв вернул всех проглоченных (${blown.length} из ${inHole})`,
  );
  check(
    blown.every((node) => (node.eject?.vx ?? 0) !== 0 || (node.eject?.vz ?? 0) !== 0),
    'выброшенные орбы получили скорость — разлетаются, а не появляются на месте',
  );
  for (let frame = 0; frame < 600; frame++) eater.update(1 / 60, 20 + frame / 60, null);
  check(
    blown.every((node) => node.fx !== null && node.fy !== null),
    'разлетевшиеся орбы закрепились там, где остановились',
  );
  check(eater.dumpCount === 0, 'после взрыва дыра пуста');
  check(
    eater.ejectAll(HOLE_EJECT_SPEED).length === 0,
    'повторный взрыв ничего не добавляет — выбрасывать больше нечего',
  );

  // Схлопывание: те же орбы возвращаются тихо, рядом с дырой.
  const quite = new ForceGraph();
  quite.sync(inspectConnections);
  quite.absorbEverything();
  const returnedQuietly = quite.ejectAll(0);
  check(returnedQuietly.length > 0, `схлопывание вернуло орбы (${returnedQuietly.length})`);
  check(
    returnedQuietly.every((node) => node.eject === undefined),
    'при схлопывании орбы не разлетаются — они просто возвращаются в сцену',
  );

  // ── Слияние: два орба руками становятся одним, и это обратимо ──
  console.log('Сеть: слияние орбов — два процесса становятся одним (и обратно)');
  const merger = new ForceGraph();
  merger.sync(inspectConnections);
  const mergePair = merger.nodes.filter((node) => node.kind === 'remote');
  check(mergePair.length >= 2, `есть кого сливать: процессов ${mergePair.length}`);
  const beforeLinks = merger.connectionsOf(mergePair[1]).length;
  const beforeCount = merger.nodes.length;
  const merged = merger.merge(mergePair[0], mergePair[1]);
  check(Boolean(merged), 'слияние состоялось');
  check(merger.nodes.length === beforeCount - 1 && !merger.nodes.includes(mergePair[0]), 'исчезнувший орб ушёл со сцены');
  check(merger.mergeCount === 1, 'сцена помнит про слияние');
  check(
    merger.nodes.every((node) => node !== mergePair[0] || merger.dragged === node) &&
      merger.links.every((link) => link.source !== mergePair[0] && link.target !== mergePair[0]),
    'на исчезнувшем орбе не осталось висящих линий',
  );
  const grown = merger.connectionsOf(mergePair[1]).length;
  check(
    grown > beforeLinks,
    `подключения перешли к выжившему (${beforeLinks} → ${grown})`,
  );
  check(
    (mergePair[1].mergedFrom ?? []).includes(mergePair[0].label),
    'выживший помнит, кого вобрал',
  );
  const beforeMergeId = mergePair[0].id;
  merger.sync(inspectConnections);
  check(!merger.nodes.includes(mergePair[0]), 'новая синхронизация не оживляет слитый орб');
  check(!merger.canMerge(mergePair[0], mergePair[1]), 'слить исчезнувший орб уже нельзя');
  check(merger.undoRewire(), 'слияние отменяется');
  check(
    merger.nodes.some((node) => node.id === beforeMergeId),
    '«Обратно» вернуло орб в сцену',
  );
  check(merger.mergeCount === 0, 'сцена снова не помнит про слияние');
  check(
    (mergePair[1].mergedFrom ?? []).length === 0,
    'выживший больше не помнит про вобранный орб',
  );
  merger.sync(inspectConnections);
  for (let frame = 0; frame < 200; frame++) merger.update(1 / 60, 60 + frame / 60, null);
  const restoredLinks = merger.connectionsOf(mergePair[1]).length;
  check(
    Math.abs(restoredLinks - beforeLinks) <= 1,
    `после отмены связи вернулись к прежнему числу (${beforeLinks} → ${restoredLinks})`,
  );
  check(
    !merger.canMerge(mergePair[0], merger.nodes.find((node) => node.kind === 'local')!),
    'сливать орб с машиной нельзя — это другой тип',
  );
  merger.dispose();
  quite.dispose();
  eater.dispose();
  stretched.dispose();

  console.log('Жесты: экономный режим (общая частота с рендером)');
  // Модель и рендер делят один GPU: при просадке FPS распознавание реже, картинка плавнее.
  check(economyRate(60) === 30 && economyRate(45) === 30, 'свободный рендер — 30 Гц распознавания');
  check(economyRate(38) === 20, 'просадка до 38 FPS — 20 Гц');
  check(economyRate(18) === 12, 'тяжёлая сцена (18 FPS) — экономные 12 Гц');
  check(economyRate(0) === 30 && economyRate(Number.NaN) === 30, 'неизвестный FPS не ломает расчёт');
  check([12, 20, 30].every((hz) => hz >= 12 && hz <= 30), 'частота остаётся в разумных пределах');

  console.log(failures === 0 ? '\nВсе проверки пройдены ✅' : `\nПровалено проверок: ${failures} ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
