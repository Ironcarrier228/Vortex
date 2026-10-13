# Зависимости и почему именно они

## npm (фронтенд)

| Пакет | Версия | Зачем | Почему не альтернатива |
| --- | --- | --- | --- |
| `three` | ^0.186 | WebGL-рендер, `EffectComposer`, `UnrealBloomPass`, `OutputPass` | Написанная с нуля WebGL-обвязка не даёт ничего, кроме недель работы |
| `@types/three` | ^0.186 | Типы для three (в т.ч. для `examples/jsm`) | — |
| `d3-force-3d` | 3.0.6 | Force-directed раскладка графа в 3D (`forceManyBody`, `forceLink`, `forceRadial`) | Самописная физика хуже по качеству; у пакета нет `.d.ts` — типы описаны локально в `src/types/d3-force-3d.d.ts`. **Важно:** число измерений задаётся вторым аргументом `forceSimulation(nodes, 3)`, по умолчанию 2 |
| `@mediapipe/tasks-vision` | ^1.1.0 | Распознавание кисти (21 точка) из веб-камеры: `HandLandmarker` + WASM | Альтернативы: `handtrack.js`/`tracking.js` — заметно ниже точность и нет 3D-точек; `ml5.js` тянет TensorFlow (~2 МБ) и не даёт WASM+GPU-делегат. Пакет нужен только как **источник файлов** (`npm run sync:mediapipe` копирует `vision_bundle.js` + WASM в `public/mediapipe/`; готовые файлы не перезаписываются, занятые — пропускаются с предупреждением): библиотека подключается в рантайме тегом `<script>` (локальная копия → CDN), поэтому жёсткой зависимости на этапе сборки нет — без `npm install` приложение собирается и работает, жесты показывают понятную ошибку |
| `@tauri-apps/api` | 2.12.3 | `invoke`, `listen`, `emit`, `getCurrentWindow` | — |
| `@tauri-apps/cli` | 2.12.2 | `tauri dev/build`, генерация схем capabilities | — |
| `vite` | ^7 | dev-сервер с hot reload, сборка | Webpack/esbuild-обвязка тяжелее, hot reload хуже |
| `typescript` | ^5.9 | Строгая типизация контракта с Rust | — |

Модель руки (`hand_landmarker.task`, Apache-2.0, 7 819 105 байт) в репозиторий не кладётся: её
скачивает `npm run fetch:models` в `public/models/` (папка в `.gitignore`). Без файла распознавание
работает по сети: сначала официальный Google Storage, затем зеркала на CDN npm
(`expo-vision-camera-v4-mediapipe@1.4.0` — тот же файл, sha256 совпадает); Google Storage доступен
не везде, поэтому зеркала не роскошь. Если не вышло ничего — приложение переключается на демо-руку
и объясняет причину на плашке состояния.

Сознательно **не** добавлено:

* `postprocessing` (npm) — сторонний форк с собственным API; официальных `three/examples/jsm` достаточно,
  а собственный `GradePass` даёт полный контроль над переходами между сценами.
* `three-gpu-pathtracer`, `three-mesh-bvh` — избыточно для визуализаций без глобального освещения.
* CSS-фреймворки — HUD это ~300 строк CSS, тянуть Tailwind/UI-kit смысла нет.

## Cargo (Rust)

### `src-tauri`

| Крейт | Версия | Зачем | Примечания |
| --- | --- | --- | --- |
| `tauri` | 2 | окно, IPC, события, мультиоконность | Требуется WebView2 (в Win10/11 предустановлен) |
| `tauri-build` | 2 | кодогенерация контекста | build-dependency |
| `serde` / `serde_json` | 1 | сериализация пейлоадов | `rename_all = "camelCase"` — чтобы TS-типы читались естественно |
| `jwalk` | 0.8 | параллельный обход ФС на rayon | Быстрее `walkdir` в 2–4 раза на NVMe; отдаёт `DirEntry` с ленивыми метаданными |
| `wasapi` | 0.26 | захват системного звука (loopback), COM-обёртки | Тянет `windows`/`windows-core` 0.62 только на Windows. Loopback открывается на устройстве **вывода** (`Direction::Render`) с направлением захвата; в shared-режиме читаем `get_mixformat()` и конвертируем сами |
| `vortex-core` | path | FFT, diff соединений, дерево диска | Локальный крейт, тестируется на Linux/macOS |

### `crates/vortex-core`

| Крейт | Версия | Зачем |
| --- | --- | --- |
| `rustfft` | 6.2 | FFT с автовыбором SIMD (AVX2/SSE) — 2048-точечное преобразование ≈0.02 мс на кадр, на порядок дешевле, чем `realfft` + ручные окна |

Остальное — std (`std::net::{Ipv4Addr, Ipv6Addr}`, `Path`, `HashMap`).

### Прямой FFI вместо крейта `windows`

`GetExtendedTcpTable`, `GetExtendedUdpTable`, `OpenProcess`, `QueryFullProcessImageNameW`, `OpenProcessToken`,
`GetTokenInformation`, `GlobalMemoryStatusEx` и `SHFileOperationW` объявлены прямо через `extern "system"`.
Причина: используется ~10 функций, а связка «версия крейта `windows` ↔ набор фич ↔ версия `wasapi`»
даёт самые неприятные ошибки сборки. Крейт `windows` всё равно подтягивается транзитивно через `wasapi`
только на Windows и не участвует в публичном API.

### Что появится на следующих этапах (обоснование заранее)

| Крейт | Этап | Зачем |
| --- | --- | --- |
| `ferrisetw` **или** прямой `StartTraceW`/`ProcessTrace` | 3 | ETW-сессии `Microsoft-Windows-Kernel-Network` и `Microsoft-Windows-TCPIP` для байт/с по PID. `ferrisetw` удобнее, но требует макросов-генераторов событий; при несовместимости версий — свой минимальный ETW-хелпер (как с iphlpapi) |
| `maxminddb` | 3 | оффлайн-GeoIP (`GeoLite2-City.mmdb` кладётся в `assets/geoip/`, в git не коммитится — лицензия MaxMind) |
| `hickory-resolver` **или** `GetNameInfoW` | 3 | обратный DNS для «кто куда стучится» (в UI показывается хост, а не только IP) |
| `notify` | 5 | реакция на изменения в отслеживаемых каталогах (живое обновление города) |
| `rfd` **или** диалог оболочки `SHBrowseForFolderW` | 4 | выбор каталога для скана вместо `window.prompt` |

Крейт `trash` не нужен: удаление идёт через `SHFileOperationW` с `FOF_ALLOWUNDO` (корзина Windows),
что даёт нативное поведение и не тянет зависимостей.
