/**
 * Смоук-тест «головы» фронтенда без DOM/WebGL: проверяет аудиошину и мок-бэкенд
 * (генератор спектра, дерево диска, снимки сети).
 *
 * Запуск:
 *   npx esbuild tools/smoke.test.ts --bundle --format=esm --platform=node --outfile=/tmp/vortex-smoke.mjs
 *   node /tmp/vortex-smoke.mjs
 */

// Node-харнесс: мок-бэкенд использует window.setInterval, как и в браузере.
const globals = globalThis as unknown as { window?: typeof globalThis };
if (!globals.window) globals.window = globalThis;

import { installMockBackend } from '../src/core/mock/backend';
import { AudioBus } from '../src/core/audio/bus';
import { invoke, listen } from '../src/core/transport';
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

  console.log(failures === 0 ? '\nВсе проверки пройдены ✅' : `\nПровалено проверок: ${failures} ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
