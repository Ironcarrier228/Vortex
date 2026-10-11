/**
 * Общие типы данных: контракт между Rust и TypeScript.
 * Держим их в одном месте — правки в бэкенде легко синхронизировать.
 */

/* ─────────────────────────── Аудио (WASAPI loopback) ─────────────────────────── */

export interface AudioFrame {
  /** Уровень сигнала, дБFS (обычно от -90 до 0). */
  level: number;
  /** Пиковое значение кадра, дБFS. */
  peak: number;
  /** Усреднённый спектр, дБ, длина = bands. */
  bands: number[];
}

export interface AudioInfo {
  available: boolean;
  device?: string;
  sampleRate?: number;
  channels?: number;
  /** Человекочитаемая причина, если захват недоступен. */
  reason?: string;
}

/* ─────────────────────────────── Сеть (IP Helper/ETW) ─────────────────────────────── */

export type NetProtocol = 'tcp' | 'udp';

export interface NetEndpoint {
  ip: string;
  port: number;
  host?: string;
  country?: string;
  city?: string;
  lat?: number;
  lon?: number;
  asn?: string;
}

export interface NetConnection {
  id: string;
  protocol: NetProtocol;
  pid: number;
  process: string;
  exePath?: string;
  local: { ip: string; port: number };
  remote: NetEndpoint;
  /** Состояние TCP (ESTABLISHED/LISTEN/...) или "-" для UDP. */
  state: string;
  /** Байт/с от ETW-провайдера (если есть права и включён ETW). */
  bytesSent?: number;
  bytesRecv?: number;
}

export interface NetSnapshot {
  connections: NetConnection[];
  /** ID соединений, появившихся с прошлого опроса (для анимации импульсов). */
  added: string[];
  /** ID соединений, которые закрылись. */
  removed: string[];
  /** Есть ли доступ к ETW (админ). */
  elevated: boolean;
  etwActive: boolean;
  /** Своя геопозиция для режима «глобус» — из настроек. */
  origin?: { lat: number; lon: number; label: string };
}

/* ────────────────────────────── Диск (скан) ────────────────────────────── */

export type DiskCategory =
  | 'dir'
  | 'video'
  | 'audio'
  | 'image'
  | 'code'
  | 'archive'
  | 'docs'
  | 'system'
  | 'junk'
  | 'other';

export interface DiskNodeInfo {
  /** Индекс узла в дереве (стабильный внутри скана). */
  id: number;
  parent: number;
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** Количество файлов в поддереве (0 для файла). */
  files: number;
  /** Расширение файла без точки (для окраски). */
  ext?: string;
  /** Крупная категория (dir/video/audio/…) — задаёт цвет в «городе». */
  category?: DiskCategory;
  modified?: number;
}

export interface DiskScanStats {
  files: number;
  dirs: number;
  bytes: number;
  elapsedMs: number;
  done: boolean;
  /** Скан ещё идёт. */
  scanning: boolean;
  /** Скан прерван пользователем. */
  cancelled: boolean;
  /** Есть ли права администратора (доступны MFT/ETW). */
  elevated: boolean;
  /** Доступен ли мгновенный скан через MFT. */
  mftAvailable: boolean;
  error?: string;
  /** Корень скана. */
  root: string;
}

export type DiskEvent =
  | { kind: 'node'; node: DiskNodeInfo }
  | { kind: 'stats'; stats: DiskScanStats }
  | { kind: 'error'; message: string };

/* ────────────────────────────── GTK/IPC-разное ────────────────────────────── */

export interface ProcInfo {
  pid: number;
  name: string;
}

/** Сообщение для HUD (приходит из Rust или мок-бэкенда). */
export interface Toast {
  kind: 'info' | 'warn' | 'error';
  message: string;
}

export interface SysInfo {
  os: string;
  elevated: boolean;
  cores: number;
  totalRam: number;
  appVersion: string;
}
