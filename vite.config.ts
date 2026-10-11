import { defineConfig } from 'vite';

/**
 * Vite работает в двух режимах:
 *  1) `npm run dev`            — обычный браузер (мок-провайдеры данных, удобно отлаживать графику);
 *  2) `npm run app:dev` (tauri) — WebView2, devUrl http://localhost:5173.
 *
 * host: 0.0.0.0 + allowedHosts включаем, чтобы dev-сервер был доступен из превью/прокси
 * и с другого устройства в LAN (актуально при отладке на втором мониторе).
 */
// process доступен в Node-окружении Vite; типы Node тянуть не хочется, поэтому читаем аккуратно.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const tauriHost = env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    host: tauriHost || '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: tauriHost ? { protocol: 'ws', host: tauriHost, port: 5174 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // WebView2 на Win10/11 = Chromium 110+, этого достаточно для всего, что мы используем.
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
