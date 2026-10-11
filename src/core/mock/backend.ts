/**
 * Мок-бэкенд для запуска фронтенда в обычном браузере (`npm run dev`).
 *
 * Он повторяет контракт Rust-команд и событий, поэтому сцены не знают, работают ли
 * они с настоящим WASAPI/IP Helper или с синтетикой. Это основной инструмент отладки
 * графики: шейдеры, bloom, переходы и HUD можно доводить без сборки Rust.
 *
 * В Tauri этот модуль не активируется (см. main.ts).
 */

import { isTauri, mockCommand, mockEmit } from '../transport';
import type { DiskCategory, DiskNodeInfo, DiskScanStats, NetConnection, NetSnapshot } from '../types';

const EV_AUDIO_FRAME = 'vortex://audio/frame';
const EV_AUDIO_INFO = 'vortex://audio/info';
const EV_NET_SNAPSHOT = 'vortex://net/snapshot';
const EV_DISK_STATS = 'vortex://disk/stats';

export function installMockBackend(): void {
  if (isTauri) return;
  console.info('[vortex] запущен мок-бэкенд: данные синтезируются во фронтенде');
  installSystem();
  installAudio();
  installNetwork();
  installDisk();
  installWindows();
}

/* ─────────────────────────── Система ─────────────────────────── */

function installSystem(): void {
  mockCommand('sys_info', () => ({
    os: 'демо-режим (браузер)',
    elevated: false,
    cores: navigator.hardwareConcurrency ?? 8,
    totalRam: 16 * 1024 ** 3,
    appVersion: '0.1.0-demo',
    features: { etw: false, mft: false, geodb: true, loopback: false },
  }));
}

/* ─────────────────────────── Аудио ─────────────────────────── */

function installAudio(): void {
  let timer = 0;
  let active = false;
  let clock = 0;

  const stop = () => {
    if (!timer) return;
    window.clearInterval(timer);
    timer = 0;
  };

  const start = () => {
    if (timer) return;
    const RATE = 60;
    timer = window.setInterval(() => {
      clock += 1 / RATE;
      if (!active) return;

      // Синтетическая «музыка»: спад 1/f + два движущихся пика + удар каждые 0.5 с.
      const beatPhase = (clock % 0.5) / 0.5;
      const kick = Math.exp(-beatPhase * 14);
      const peak1 = 0.16 + 0.1 * Math.sin(clock * 0.42);
      const peak2 = 0.52 + 0.22 * Math.sin(clock * 0.23 + 1.4);
      const bands = new Array<number>(64);
      for (let i = 0; i < 64; i++) {
        const f = i / 63;
        let amplitude = Math.exp(-f * 2.4) * 0.55;
        amplitude += Math.exp(-Math.pow((f - peak1) / 0.07, 2)) * 0.5;
        amplitude += Math.exp(-Math.pow((f - peak2) / 0.11, 2)) * 0.4;
        amplitude += Math.exp(-Math.pow((f - 0.85) / 0.05, 2)) * 0.25 * Math.max(0, Math.sin(clock * 3.1));
        amplitude += kick * Math.exp(-f * 6.0) * 0.9;
        amplitude *= 0.65 + 0.35 * Math.sin(clock * 0.7 + f * 4.0);
        const db = 20 * Math.log10(Math.max(1e-4, amplitude));
        bands[i] = Math.max(-72, Math.min(0, db));
      }
      const level = bands.reduce((sum, db) => sum + db, 0) / bands.length;
      mockEmit(EV_AUDIO_FRAME, { level, peak: Math.max(...bands), bands });
    }, 1000 / RATE);

    mockEmit(EV_AUDIO_INFO, {
      available: true,
      device: 'Демо-генератор спектра (браузер)',
      sampleRate: 48_000,
      channels: 2,
    });
  };

  mockCommand('audio_start', () => {
    active = true;
    start();
    return {
      available: true,
      device: 'Демо-генератор спектра (браузер)',
      sampleRate: 48_000,
      channels: 2,
    };
  });
  mockCommand('audio_set_active', (args) => {
    active = Boolean(args.active);
    return null;
  });
  mockCommand('audio_stop', () => {
    active = false;
    stop();
    return { available: false, reason: 'Захват остановлен' };
  });
  mockCommand('audio_status', () => ({
    available: active,
    device: active ? 'Демо-генератор спектра (браузер)' : undefined,
  }));
}

/* ─────────────────────────── Сеть ─────────────────────────── */

interface RemoteSpec {
  ip: string;
  port: number;
  protocol: 'tcp' | 'udp';
  host: string;
  country: string;
  city: string;
  lat: number;
  lon: number;
}

const REMOTES: RemoteSpec[] = [
  { ip: '142.250.74.78', port: 443, protocol: 'tcp', host: 'google.com', country: 'US', city: 'Нью-Йорк', lat: 40.71, lon: -74.0 },
  { ip: '151.101.1.140', port: 443, protocol: 'tcp', host: 'reddit.com', country: 'US', city: 'Сан-Франциско', lat: 37.77, lon: -122.42 },
  { ip: '104.16.132.229', port: 443, protocol: 'tcp', host: 'cloudflare.com', country: 'NL', city: 'Амстердам', lat: 52.37, lon: 4.9 },
  { ip: '52.94.236.248', port: 443, protocol: 'tcp', host: 'amazonaws.com', country: 'IE', city: 'Дублин', lat: 53.35, lon: -6.26 },
  { ip: '77.88.55.77', port: 443, protocol: 'tcp', host: 'yandex.ru', country: 'RU', city: 'Москва', lat: 55.75, lon: 37.62 },
  { ip: '87.240.190.78', port: 443, protocol: 'tcp', host: 'vk.com', country: 'RU', city: 'Санкт-Петербург', lat: 59.94, lon: 30.31 },
  { ip: '185.199.108.153', port: 443, protocol: 'tcp', host: 'github.io', country: 'DE', city: 'Франкфурт', lat: 50.11, lon: 8.68 },
  { ip: '162.159.128.233', port: 443, protocol: 'tcp', host: 'discord.gg', country: 'US', city: 'Даллас', lat: 32.78, lon: -96.8 },
  { ip: '34.107.221.82', port: 443, protocol: 'tcp', host: 'steampowered.com', country: 'DE', city: 'Берлин', lat: 52.52, lon: 13.4 },
  { ip: '13.107.42.14', port: 443, protocol: 'tcp', host: 'microsoft.com', country: 'US', city: 'Сиэтл', lat: 47.6, lon: -122.33 },
  { ip: '224.0.0.251', port: 5353, protocol: 'udp', host: 'mdns', country: '—', city: 'локальная сеть', lat: 0, lon: 0 },
  { ip: '8.8.8.8', port: 53, protocol: 'udp', host: 'dns.google', country: 'US', city: 'Маунтин-Вью', lat: 37.39, lon: -122.08 },
];

const PROCESSES = [
  { name: 'chrome', pid: 8420 },
  { name: 'steam', pid: 5112 },
  { name: 'discord', pid: 3344 },
  { name: 'svchost', pid: 1180 },
  { name: 'vortex', pid: 7001 },
  { name: 'Code', pid: 2456 },
];

function installNetwork(): void {
  let timer = 0;
  let pollMs = 2000;
  let election = 0;
  let lastIds = new Set<string>();

  const build = (): NetSnapshot => {
    election += 1;
    const connections: NetConnection[] = [];
    const count = 10 + (election % 4);
    for (let i = 0; i < count; i++) {
      const process = PROCESSES[(i * 7 + election) % PROCESSES.length];
      const remote = REMOTES[(i * 3 + Math.floor(election / 2)) % REMOTES.length];
      const port = 49152 + ((i * 977 + election * 13) % 16000);
      const id = `tcp:${process.pid}:${port}:${remote.ip}:${remote.port}`;
      connections.push({
        id,
        protocol: remote.protocol,
        pid: process.pid,
        process: process.name,
        client: undefined as never,
        local: { ip: '192.168.1.42', port },
        remote: {
          ip: remote.ip,
          port: remote.port,
          host: remote.host,
          country: remote.country,
          city: remote.city,
          lat: remote.lat,
          lon: remote.lon,
        },
        state: remote.protocol === 'tcp' ? 'ESTABLISHED' : '-',
      } as NetConnection);
    }

    const ids = new Set(connections.map((connection) => connection.id));
    const added = [...ids].filter((id) => !lastIds.has(id));
    const removed = [...lastIds].filter((id) => !ids.has(id));
    lastIds = ids;

    return {
      connections,
      elevated: false,
      etwActive: false,
      added,
      removed,
      origin: { lat: 55.75, lon: 37.62, label: 'Москва (демо)' },
    };
  };

  const emit = () => mockEmit(EV_NET_SNAPSHOT, build());

  mockCommand('net_start', (args) => {
    pollMs = Number(args.pollMs ?? 2000);
    if (!timer) {
      emit();
      timer = window.setInterval(emit, Math.max(500, pollMs));
    }
    return build();
  });
  mockCommand('net_stop', () => {
    if (timer) window.clearInterval(timer);
    timer = 0;
    return null;
  });
  mockCommand('net_snapshot', () => {
    const snapshot = build();
    lastIds = new Set(snapshot.connections.map((connection) => connection.id));
    return snapshot;
  });
}

/* ─────────────────────────── Диск ─────────────────────────── */

interface MockDisk {
  nodes: DiskNodeInfo[];
  byPath: Map<string, DiskNodeInfo>;
  children: Map<number, DiskNodeInfo[]>;
}

function buildMockDisk(root: string): MockDisk {
  const nodes: DiskNodeInfo[] = [];
  const byPath = new Map<string, DiskNodeInfo>();
  const children = new Map<number, DiskNodeInfo[]>();
  let nextId = 1;

  const extensions = ['mp4', 'png', 'dll', 'exe', 'zip', 'rs', 'ts', 'pdf', 'log', 'iso', 'flac', 'jpg'];
  const dirNames = ['Windows', 'Program Files', 'Users', 'Games', 'Media', 'Projects', 'Cache', 'Backups', 'Docs'];

  const rootNode: DiskNodeInfo = {
    id: 0,
    parent: 0,
    path: root,
    name: root,
    isDir: true,
    size: 0,
    files: 0,
    category: 'dir',
    ext: '',
  };
  nodes.push(rootNode);
  byPath.set(root, rootNode);

  const makeDir = (parent: DiskNodeInfo, name: string): DiskNodeInfo => {
    const node: DiskNodeInfo = {
      id: nextId++,
      parent: parent.id,
      path: joinPath(parent.path, name),
      name,
      isDir: true,
      size: 0,
      files: 0,
      category: 'dir',
      ext: '',
      modified: Date.now() - Math.random() * 3e10,
    };
    nodes.push(node);
    byPath.set(node.path, node);
    parent.files += 1;
    children.set(node.id, []);
    const parentChildren = children.get(parent.id) ?? [];
    parentChildren.push(node);
    children.set(parent.id, parentChildren);
    return node;
  };

  const makeFile = (parent: DiskNodeInfo, name: string, size: number): void => {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const node: DiskNodeInfo = {
      id: nextId++,
      parent: parent.id,
      path: joinPath(parent.path, name),
      name,
      isDir: false,
      size,
      files: 0,
      ext,
      category: categoryOf(ext),
      modified: Date.now() - Math.random() * 3e10,
    };
    nodes.push(node);
    byPath.set(node.path, node);
    const parentChildren = children.get(parent.id) ?? [];
    parentChildren.push(node);
    children.set(parent.id, parentChildren);
    // Аккумулируем размеры вверх по дереву.
    let cursor: DiskNodeInfo | undefined = parent;
    while (cursor) {
      cursor.size += size;
      cursor.files += 1;
      cursor = cursor.parent === cursor.id ? undefined : nodes.find((n) => n.id === cursor!.parent);
    }
  };

  for (const name of dirNames) {
    const dir = makeDir(rootNode, name);
    const subCount = 3 + Math.floor(Math.random() * 4);
    for (let s = 0; s < subCount; s++) {
      const sub = makeDir(dir, `${name.toLowerCase().replace(/\s/g, '')}-${s + 1}`);
      const fileCount = 12 + Math.floor(Math.random() * 40);
      for (let f = 0; f < fileCount; f++) {
        const ext = extensions[Math.floor(Math.random() * extensions.length)];
        const size = Math.floor(Math.pow(Math.random(), 2.6) * 900 * 1024 * 1024) + 4096;
        makeFile(sub, `файл-${f + 1}.${ext}`, size);
      }
    }
  }

  return { nodes, byPath, children };
}

function joinPath(parent: string, name: string): string {
  const separator = parent.endsWith('\\') || parent.endsWith('/') ? '' : '\\';
  return `${parent}${separator}${name}`;
}

function categoryOf(ext: string): DiskCategory {
  if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'm4a'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'psd'].includes(ext)) return 'image';
  if (['rs', 'ts', 'js', 'py', 'json', 'toml'].includes(ext)) return 'code';
  if (['zip', '7z', 'rar', 'iso', 'gz'].includes(ext)) return 'archive';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'csv'].includes(ext)) return 'docs';
  if (['dll', 'exe', 'sys', 'msi'].includes(ext)) return 'system';
  if (['log', 'tmp', 'dmp'].includes(ext)) return 'junk';
  return 'other';
}

function installDisk(): void {
  let disk: MockDisk | null = null;
  let cancelled = false;
  let scanning = false;
  let stats: DiskScanStats = {
    root: 'C:\\',
    files: 0,
    dirs: 0,
    bytes: 0,
    elapsedMs: 0,
    done: false,
    scanning: false,
    cancelled: false,
    elevated: false,
    mftAvailable: false,
  };

  mockCommand('disk_scan', (args) => {
    const root = String(args.root ?? 'C:\\');
    cancelled = false;
    scanning = true;
    stats = {
      root,
      files: 0,
      dirs: 0,
      bytes: 0,
      elapsedMs: 0,
      done: false,
      scanning: true,
      cancelled: false,
      elevated: false,
      mftAvailable: false,
    };
    const started = performance.now();
    mockEmit(EV_DISK_STATS, { ...stats });

    // Асинхронно «сканируем»: сначала пустое дерево, потом наполняем по частям.
    window.setTimeout(() => {
      disk = buildMockDisk(root);
      const total = disk.nodes.length;
      let emitted = 0;
      const step = () => {
        if (cancelled) {
          stats = { ...stats, done: true, scanning: false, cancelled: true, elapsedMs: performance.now() - started };
          scanning = false;
          mockEmit(EV_DISK_STATS, stats);
          return;
        }
        emitted = Math.min(total, emitted + Math.max(20, Math.floor(total / 12)));
        const slice = disk!.nodes.slice(0, emitted);
        stats = {
          ...stats,
          files: slice.filter((node) => !node.isDir).length,
          dirs: slice.filter((node) => node.isDir).length,
          bytes: slice.reduce((sum, node) => sum + (node.isDir ? 0 : node.size), 0),
          elapsedMs: performance.now() - started,
        };
        mockEmit(EV_DISK_STATS, stats);
        if (emitted < total) window.setTimeout(step, 90);
        else {
          const rootNode = disk!.nodes[0];
          stats = {
            ...stats,
            files: rootNode.files,
            bytes: rootNode.size,
            done: true,
            scanning: false,
            elapsedMs: performance.now() - started,
          };
          scanning = false;
          mockEmit(EV_DISK_STATS, stats);
        }
      };
      window.setTimeout(step, 120);
    }, 60);

    return stats;
  });

  mockCommand('disk_cancel', () => {
    cancelled = true;
    return null;
  });

  mockCommand('disk_children', (args) => {
    if (!disk) return [];
    const path = String(args.path ?? '');
    const node = disk.byPath.get(path);
    if (!node) return [];
    const list = disk.children.get(node.id) ?? [];
    return [...list].sort((a, b) => b.size - a.size).slice(0, 4000);
  });

  mockCommand('disk_stats', () => stats);

  mockCommand('disk_delete_to_trash', (args) => {
    void scanning;
    const path = String(args.path ?? '');
    if (!disk) throw new Error('Дерево не построено');
    const node = disk.byPath.get(path);
    if (!node) throw new Error(`Объект не найден: ${path}`);
    // Эмулируем корзину: помечаем удалёнными у родителя и вычитаем размеры вверх.
    const parentChildren = disk.children.get(node.parent) ?? [];
    disk.children.set(
      node.parent,
      parentChildren.filter((child) => child.id !== node.id),
    );
    disk.byPath.delete(path);
    let cursor: DiskNodeInfo | undefined = node;
    while (cursor) {
      const parent = disk.nodes.find((item) => item.id === cursor!.parent);
      if (!parent || parent.id === cursor.id) break;
      parent.size = Math.max(0, parent.size - node.size);
      parent.files = Math.max(0, parent.files - (node.isDir ? node.files : 1));
      cursor = parent;
    }
    return null;
  });
}

/* ─────────────────────────── Окна ─────────────────────────── */

function installWindows(): void {
  mockCommand('open_output_window', () => {
    mockEmit('vortex://toast', {
      kind: 'warn',
      message: 'Второе окно доступно только в сборке Tauri (в браузере — демо-режим)',
    });
    return { open: false, monitor: null, label: 'output' };
  });
  mockCommand('close_output_window', () => ({ open: false, monitor: null, label: 'output' }));
  mockCommand('toggle_main_fullscreen', () => null);
}
