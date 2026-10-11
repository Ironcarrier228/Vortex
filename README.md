# VORTEX — 3D-центр визуализации данных

Windows-приложение (Win 10/11): Tauri 2 (Rust) снимает данные (сеть / диск / системный звук),
фронтенд на three.js рисует три 3D-сцены с общим рендер-слоем, bloom и «пролётом» камеры между сценами.

> Полные документы: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Быстрый старт

```bash
npm install

# 1) Только фронтенд — в браузере, на мок-провайдерах (данные синтезируются).
#    Удобно отлаживать шейдеры/пост-обработку, не поднимая Rust.
npm run dev            # http://localhost:5173

# 2) Полное приложение (Windows): нужен Rust + MSVC build tools + WebView2.
npm run app:dev        # tauri dev
npm run app:build      # tauri build → msi/nsis в src-tauri/target/release/bundle
```

Горячие клавиши: `1/2/3` — сцена, `M` — режим внутри сцены, `Space` — пауза,
`H` — HUD, `F` — fullscreen, `W` — окно вывода на второй монитор, `S` — настройки, `Esc` — снять выделение/выход.

## Проверки без Windows

```bash
npm run typecheck     # строгие типы фронтенда
npm run smoke         # смоук-тест аудиошины, мок-сети и дерева диска (Node, без WebGL)
cargo test -p vortex-core   # чистая логика Rust: FFT-анализ, diff соединений, дерево диска
```

## Что уже работает

| Слой | Состояние |
| --- | --- |
| Рендер-слой (WebGL2, bloom, grade, warp-переходы, адаптивное разрешение) | готов |
| HUD, хоткеи, настройки, статистика | готов |
| Сцена 2 «Аудиовизуализатор»: спектр / частицы / тоннель / сфера (GLSL) | готов |
| Провайдер аудио: WASAPI loopback → FFT (rustfft) → кадры 60 Гц | готов (Windows) |
| Сцена 1 «Карта сети»: force-directed 3D граф, импульсы, tooltip, режим «глобус» | каркас + мок-данные |
| Провайдер сети: IP Helper (PID↔соединение), ETW-трафик (admin), GeoIP | IP Helper готов, ETW — этап 3 |
| Сцена 3 «Анализатор диска»: город (instanced), drill-down, удаление в корзину | каркас + мок-данные |
| Провайдер диска: jwalk-скан + инкрементальные события, MFT (admin) | jwalk готов, MFT — этап 4 |
| Окно вывода на второй монитор (безрамочное, fullscreen) | готово |

## Структура

```
Vortex/
├── src/                 # фронтенд (TypeScript, three.js)
│   ├── core/            # рендер-слой, пост-обработка, HUD, переходы, транспорт, сцена-модули
│   ├── scenes/          # независимые модули сцен: audio / network / disk
│   └── sources/         # источники данных во фронтенде (мок, WebAudio)
├── crates/vortex-core/  # чистый Rust: FFT/анализ, diff таблиц соединений, дерево диска (тесты)
└── src-tauri/           # Tauri 2: команды, события, провайдеры (wasapi/iphlpapi/jwalk), окна
```
