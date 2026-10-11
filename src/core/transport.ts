/**
 * Транспорт между UI и Rust-бэкендом.
 *
 * В Tauri — это `invoke`/`listen` из @tauri-apps/api (ленивый импорт: тот же код должен
 * работать в обычном браузере, где Tauri нет). В браузере команды обслуживает мок-бэкенд
 * (см. src/core/mock/), поэтому `npm run dev` даёт полноценную песочницу с данными.
 */
import { TypedEmitter } from './events';

export interface BackendEvents {
  [event: string]: unknown;
}

type Handler = (args: Record<string, unknown>) => unknown;

const mockEmitter = new TypedEmitter<BackendEvents>();
const mockCommands = new Map<string, Handler>();

/** Зарегистрировать команду мок-бэкенда (используется только вне Tauri). */
export function mockCommand(name: string, handler: Handler): void {
  mockCommands.set(name, handler);
}

/** Послать «событие бэкенда» в мок-режиме. */
export function mockEmit(event: string, payload: unknown): void {
  mockEmitter.emit(event, payload);
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let invokeImpl: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let listenImpl:
  | ((event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>)
  | null = null;

if (isTauri) {
  void (async () => {
    const core = await import('@tauri-apps/api/core');
    const event = await import('@tauri-apps/api/event');
    invokeImpl = core.invoke as never;
    listenImpl = event.listen as never;
  })().catch((err) => console.error('[transport] не удалось загрузить Tauri API:', err));
}

/** Вызвать команду Rust. В браузере — обработчик мока. */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (invokeImpl) return (await invokeImpl(cmd, args)) as T;
  if (!isTauri) {
    // Даём мок-командам «проявиться» асинхронно, как настоящий IPC.
    if (!invokeImpl) await new Promise((r) => setTimeout(r, 0));
    const handler = mockCommands.get(cmd);
    if (handler) return (await handler(args)) as T;
    console.warn(`[transport] нет мок-обработчика для команды "${cmd}"`);
    return undefined as T;
  }
  return undefined as T;
}

/**
 * Подписка на событие бэкенда. Возвращает функцию отписки.
 * В мок-режиме подписка живёт на внутреннем emitter'е.
 */
export function listen<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  if (isTauri) {
    void (async () => {
      // Ждём инициализации ленивого импорта Tauri API.
      for (let i = 0; i < 100 && !listenImpl; i++) await new Promise((r) => setTimeout(r, 20));
      if (disposed || !listenImpl) return;
      unlisten = await listenImpl(event, (e) => cb(e.payload as T));
    })().catch((err) => console.error(`[transport] listen("${event}") ошибка:`, err));
  } else {
    const off = mockEmitter.on(event, (payload) => cb(payload as T));
    unlisten = off;
  }

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Отправить событие во фронтенд из мок-бэкенда (для сцен, работающих в браузере). */
export function listenMock<T>(event: string, cb: (payload: T) => void): () => void {
  return mockEmitter.on(event, (payload) => cb(payload as T));
}
