/**
 * HUD: вкладки сцен, панели управления, статистика, настройки, тосты, тултипы
 * и модальное подтверждение. Сцены добавляют свои панели через `SceneModule.hudPanel()`.
 *
 * HUD не знает, как рисуются сцены, а сцены не знают о разметке HUD: связь идёт через
 * узкий интерфейс `AppHost` и фабрику панелей.
 */

import { HUD_CSS } from './styles';
import type { AudioModeId, Prefs, PrefsStore, SceneId } from '../prefs';
import type { Engine } from '../render/engine';

export interface AppHost {
  setScene(id: SceneId): void;
  /** Включить/выключить распознавание рук (клавиша G, кнопка HUD). */
  toggleHands(): void;
  currentScene(): SceneId;
  setMode(mode: AudioModeId): void;
  togglePause(): void;
  toggleHud(): void;
  toggleFullscreen(): void;
  toggleOutputWindow(): void;
  toggleSettings(): void;
  /** Камеры для выбора в настройках (метки доступны после выдачи разрешения). */
  listCameras(): Promise<{ id: string; label: string }[]>;
  info(): {
    os: string;
    elevated: boolean;
    version: string;
    sourceLabel: string;
    sceneTitle: string;
    modeLabel: string;
    paused: boolean;
    hudVisible: boolean;
    hands: boolean;
  };
}

export interface TooltipRow {
  k: string;
  v: string;
}

const SCENES: { id: SceneId; name: string; key: string }[] = [
  { id: 'audio', name: 'Аудиовизуализатор', key: '1' },
  { id: 'network', name: 'Карта сети', key: '2' },
  { id: 'disk', name: 'Анализатор диска', key: '3' },
];

/** Разметка строится строками — так проще править без шаблонизатора. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export class Hud {
  readonly root: HTMLElement;
  #host: AppHost;
  #prefs: PrefsStore;
  #engine: Engine;

  #tabs = new Map<SceneId, HTMLButtonElement>();
  #modeButtons = new Map<AudioModeId, HTMLButtonElement>();
  #scenePanelHost!: HTMLElement;
  #statsValues = new Map<string, HTMLElement>();
  #spark!: HTMLCanvasElement;
  #sparkCtx: CanvasRenderingContext2D | null = null;
  #sparkData: number[] = new Array(90).fill(0);
  #tooltip!: HTMLElement;
  #toasts!: HTMLElement;
  #settingsWrap!: HTMLElement;
  #chips: HTMLElement[] = [];
  #hintEl!: HTMLElement;
  #modalOpen = false;
  #lastSparkDraw = 0;
  #scenePanel: HTMLElement | null = null;

  constructor(root: HTMLElement, engine: Engine, host: AppHost, prefs: PrefsStore) {
    this.root = root;
    this.#engine = engine;
    this.#host = host;
    this.#prefs = prefs;

    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);

    this.#build();
    this.#bindHotkeys();
  }

  /* ─────────────────────────── Построение ─────────────────────────── */

  #build(): void {
    const top = el('div', 'hud-top');

    const brand = el('div', 'hud-brand hud-panel');
    brand.appendChild(el('div', 'hud-brand-name', 'VORTEX'));
    brand.appendChild(el('div', 'hud-brand-sub', '3D центр визуализации данных'));
    const chips = el('div', 'hud-chips');
    this.#chips = [
      el('span', 'hud-chip', 'WIN'),
      el('span', 'hud-chip', 'СЕТЬ'),
      el('span', 'hud-chip', 'АУДИО'),
    ];
    for (const chip of this.#chips) chips.appendChild(chip);
    brand.appendChild(chips);
    top.appendChild(brand);

    const tabs = el('div', 'hud-tabs hud-panel');
    for (const scene of SCENES) {
      const button = el('button', 'hud-tab');
      button.innerHTML = `<span class="hud-tab-name">${scene.name}</span><span class="hud-tab-key">${scene.key}</span>`;
      button.addEventListener('click', () => this.#host.setScene(scene.id));
      this.#tabs.set(scene.id, button);
      tabs.appendChild(button);
    }
    top.appendChild(tabs);
    top.appendChild(el('div', 'hud-spacer'));

    const actions = el('div', 'hud-actions hud-panel');
    actions.appendChild(this.#actionButton('⏸', 'Пауза (Space)', () => this.#host.togglePause(), 'pause'));
    actions.appendChild(this.#actionButton('⚙', 'Настройки (S)', () => this.#host.toggleSettings(), 'settings'));
    actions.appendChild(this.#actionButton('⧉', 'Окно вывода (W)', () => this.#host.toggleOutputWindow(), 'output'));
    actions.appendChild(this.#actionButton('⛶', 'Полный экран (F)', () => this.#host.toggleFullscreen(), 'fullscreen'));
    actions.appendChild(this.#actionButton('✋', 'Управление жестами (G)', () => this.#host.toggleHands(), 'hands'));
    actions.appendChild(this.#actionButton('▣', 'Скрыть HUD (H)', () => this.#host.toggleHud(), 'hud'));
    top.appendChild(actions);
    this.root.appendChild(top);

    // Правая колонка: статистика + настройки.
    const side = el('aside', 'hud-side');
    side.appendChild(this.#buildStatsPanel());
    this.#settingsWrap = el('div', 'hud-panel');
    side.appendChild(this.#settingsWrap);
    this.root.appendChild(side);

    // Низ-лево: панель активной сцены.
    this.#scenePanelHost = el('div', 'hud-scene-panel');
    this.root.appendChild(this.#scenePanelHost);

    // Низ: подсказка по горячим клавишам.
    this.#hintEl = el('div', 'hud-bottom hud-panel');
    this.#hintEl.innerHTML = [
      '<span><span class="hud-kbd">1</span>—<span class="hud-kbd">3</span> сцены</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">M</span> режим</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">Space</span> пауза</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">H</span> HUD</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">W</span> вывод</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">F</span> фullscreen</span>',
      '<span class="sep">·</span>',
      '<span><span class="hud-kbd">G</span> жесты</span>',
      '<span class="sep">·</span>',
      '<span data-role="hands" class="hud-label">жесты выключены</span>',
    ].join('');
    this.root.appendChild(this.#hintEl);

    this.#tooltip = el('div', 'hud-tooltip');
    this.root.appendChild(this.#tooltip);

    this.#toasts = el('div', 'hud-toasts');
    this.root.appendChild(this.#toasts);

    this.#buildSettings();
    this.refresh();
  }

  #actionButton(label: string, title: string, onClick: () => void, id: string): HTMLButtonElement {
    const button = el('button', 'hud-btn', label);
    button.title = title;
    button.dataset.action = id;
    button.addEventListener('click', onClick);
    return button;
  }

  #buildStatsPanel(): HTMLElement {
    const panel = el('div', 'hud-panel');
    const inner = el('div', 'hud-panel-inner');
    inner.appendChild(el('div', 'hud-panel-title', '<strong>Производительность</strong><span class="hud-label" data-role="resolution">—</span>'));

    const grid = el('div', 'hud-stat-grid');
    const stats: [string, string][] = [
      ['fps', 'FPS'],
      ['work', 'Работа кадра'],
      ['frame', 'Кадр'],
      ['scale', 'Масштаб'],
    ];
    const labels: Record<string, string> = {
      fps: 'FPS',
      work: 'Работа кадра',
      frame: 'Средний кадр',
      scale: 'Масштаб рендера',
    };
    for (const [key] of stats) {
      const cell = el('div', 'hud-stat');
      cell.appendChild(el('div', 'hud-label', labels[key]));
      const value = el('div', 'hud-stat-value hud-mono', '—');
      cell.appendChild(value);
      this.#statsValues.set(key, value);
      grid.appendChild(cell);
    }
    inner.appendChild(grid);

    const spark = el('canvas', 'hud-spark');
    spark.width = 560;
    spark.height = 80;
    this.#spark = spark;
    this.#sparkCtx = spark.getContext('2d');
    inner.appendChild(spark);

    const drawCall = el('div', 'hud-row');
    drawCall.style.marginTop = '8px';
    drawCall.appendChild(el('span', 'hud-label', 'draw calls'));
    const callsValue = el('span', 'hud-stat-value hud-mono', '0');
    drawCall.appendChild(callsValue);
    this.#statsValues.set('calls', callsValue);
    inner.appendChild(drawCall);

    panel.appendChild(inner);
    return panel;
  }

  #buildSettings(): void {
    const inner = el('div', 'hud-panel-inner hud-settings hud-scroll');
    const title = el('div', 'hud-panel-title');
    title.appendChild(el('strong', '', 'Настройки визуала'));
    const reset = el('button', 'hud-btn', 'сброс');
    reset.style.height = '24px';
    reset.addEventListener('click', () => {
      this.#prefs.reset();
      this.toast('info', 'Настройки сброшены к значениям по умолчанию');
    });
    title.appendChild(reset);
    inner.appendChild(title);

    const category = (text: string) => {
      inner.appendChild(el('div', 'hud-label', text));
      inner.appendChild(el('div', 'hud-divider'));
    };

    category('Пост-обработка');
    inner.appendChild(
      this.#switchField('Блум (свечение)', 'bloomEnabled', () => {
        this.#engine.invalidate();
      }),
    );
    inner.appendChild(this.#sliderField('Сила блума', 'bloomStrength', 0, 2, 0.02));
    inner.appendChild(this.#sliderField('Радиус блума', 'bloomRadius', 0, 1.5, 0.02));
    inner.appendChild(this.#sliderField('Порог блума', 'bloomThreshold', 0, 1, 0.01));
    inner.appendChild(this.#sliderField('Экспозиция', 'exposure', 0.4, 2, 0.01));
    inner.appendChild(this.#sliderField('Контраст', 'contrast', 0.6, 1.8, 0.01));
    inner.appendChild(this.#sliderField('Насыщенность', 'saturation', 0.4, 2, 0.01));
    inner.appendChild(this.#sliderField('Хром. аберрации', 'chroma', 0, 1.5, 0.01));
    inner.appendChild(this.#sliderField('Виньетка', 'vignette', 0, 1, 0.01));
    inner.appendChild(this.#sliderField('Зерно', 'grain', 0, 0.4, 0.005));

    category('Производительность');
    inner.appendChild(this.#switchField('Адаптивное разрешение', 'adaptiveQuality'));
    inner.appendChild(this.#switchField('Пауза в фоне', 'pauseWhenHidden'));
    inner.appendChild(this.#selectField('Лимит FPS', 'fpsCap', [
      ['unlimited', 'без лимита'],
      ['60', '60'],
      ['30', '30'],
    ]));

    category('Управление жестами (веб-камера)');
    inner.appendChild(
      this.#switchField('Распознавание рук', 'handEnabled', () => this.#host.toggleHands()),
    );
    inner.appendChild(this.#switchField('Демо-рука (без камеры)', 'handDemo'));
    inner.appendChild(this.#switchField('Зеркалить движение', 'handMirror'));
    inner.appendChild(this.#switchField('Показывать скелет кисти', 'handShowSkeleton'));
    inner.appendChild(this.#switchField('Превью камеры', 'handShowPreview'));
    inner.appendChild(this.#cameraField());
    // Свайпы и пауза ладонью выключены по умолчанию (срабатывали случайно) — включаются тут.
    inner.appendChild(this.#switchField('Свайп переключает сцены', 'handSwipeScenes'));
    inner.appendChild(this.#switchField('Пауза открытой ладонью', 'handPauseGesture'));
    inner.appendChild(this.#switchField('Кулак возвращает раскладку', 'handFistReset'));
    inner.appendChild(
      this.#switchField('Крайний исход чёрной дыры', 'holeVoid'),
    );
    inner.appendChild(this.#sliderField('Усиление движения', 'handSensitivity', 0.6, 2.5, 0.05));
    inner.appendChild(this.#sliderField('Сглаживание', 'handSmoothing', 0, 0.95, 0.05));
    inner.appendChild(
      el(
        'div',
        'hud-label',
        'Щипок двумя пальцами — вырвать орб из цепочки: он растёт, подключения тянутся за ним ' +
          'вяло (резинка ~2 секунды), а потом их забирает СОСЕДНИЙ орб — линии с перелётом ' +
          'переходят к нему, цепочка не рушится. На спокойном отпускании орб остаётся там, ' +
          'где вы его оставили; поворотом кисти он крутится.\n\n' +
          'ПЕРЕДАЧА ПОДКЛЮЧЕНИЙ (клавиша T или кнопка «Передать подключения»): щипните орб, ' +
          'который отдаёт — он станет розовым, а подходящие приёмники подсветятся; затем щипните ' +
          'орб того же типа (процесс на процесс, хост на хост) — подключения перелетят к нему. ' +
          'В тосте есть кнопка «Обратно». Так же работает перетаскивание орба на орб.\n\n' +
          'Рывок кистью при отпускании — БРОСОК: впереди раскрывается чёрная дыра, затягивает орб ' +
          'по спирали и поглощает его. Дыра не исчезает: щипните по ней — она раскроется и отдаст ' +
          'случайный проглоченный орб прямо в руку.\n\n' +
          'СЛИЯНИЕ ОРБОВ (клавиша Y или кнопка «Слить орбы»): щипните орб, который растворится, ' +
          'затем того, в кого сливать; сводить орбы можно и двумя руками — один в левой, второй ' +
          'в правой. Первый исчезает, его подключения переходят к выжившему, а «Обратно» возвращает всё.\n\n' +
          'РАСТЯНУТАЯ ЧЁРНАЯ ДЫРА: щипните её двумя руками и разведите. Слабо — она схлопнется и ' +
          'вернёт проглоченные орбы; сильнее — ВЗОРВЁТСЯ, и орбы разлетятся по сцене, оставшись, где ' +
          'остановятся; на максимуме (если включён «Крайний исход чёрной дыры») — поглотит всё, ' +
          'включая приложение. Сцена предупреждает тостами. Свести/развести две руки без узлов — ' +
          'сложить ВСЮ сцену в ладонь и развернуть обратно (масштаб ' +
          'содержимого, а не зум камеры): свёрнутая сцена висит между кистями. Поворот кистей — ' +
          'вращение вида.\n\n' +
          'Щипок в пустоте — взялись за саму сцену: движение вращает и наклоняет граф. Вторая рука ' +
          'щипком берёт ВТОРОЙ орб — двумя руками можно развести два узла или свести их для слияния. ' +
          'Одна рука держит орб, вторая щипнула чёрную дыру — орб уходит за горизонт без броска.\n\n' +
          'Порог щипка подстраивается под руку автоматически, состояние камеры (разрешение, кадры, ' +
          'яркость) видно в превью — если рук нет, там сразу понятно почему. Большой палец вверх — ' +
          'действие сцены.',
      ),
    );

    category('Аудио');
    inner.appendChild(this.#switchField('Автозапуск захвата', 'audioAutoStart'));
    inner.appendChild(this.#selectField('Источник', 'audioSource', [
      ['system', 'системный звук (WASAPI)'],
      ['mic', 'микрофон'],
      ['none', 'тишина'],
    ]));

    this.#settingsWrap.appendChild(inner);
    this.#settingsWrap.style.display = 'none';
  }

  /** Слайдер для числовой настройки. */
  #sliderField(label: string, key: keyof Prefs, min: number, max: number, step: number): HTMLElement {
    const field = el('div', 'hud-field');
    const head = el('div', 'hud-field-head');
    head.appendChild(el('span', 'hud-label', label));
    const value = el('span', 'hud-field-value', '—');
    head.appendChild(value);
    field.appendChild(head);

    const input = el('input', 'hud-slider') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);

    const read = (): number => Number(this.#prefs.get()[key] ?? 0);
    const format = (numeric: number): string => numeric.toFixed(step < 0.01 ? 3 : 2);
    input.value = String(read());
    value.textContent = format(read());

    input.addEventListener('input', () => {
      const numeric = Number(input.value);
      value.textContent = format(numeric);
      this.#prefs.set({ [key]: numeric } as Partial<Prefs>);
    });
    field.appendChild(input);

    // Внешние изменения (сброс настроек) должны отражаться на контроле.
    this.#prefs.subscribe((_prefs, changed) => {
      if (!changed.includes(key)) return;
      input.value = String(read());
      value.textContent = format(read());
    });
    return field;
  }

  /** Переключатель для булевой настройки. */
  #switchField(label: string, key: keyof Prefs, onChange?: () => void): HTMLElement {
    const field = el('div', 'hud-field');
    const head = el('div', 'hud-field-head');
    head.appendChild(el('span', 'hud-label', label));
    const toggle = el('div', 'hud-switch');
    const read = (): boolean => Boolean(this.#prefs.get()[key]);
    toggle.classList.toggle('on', read());
    toggle.addEventListener('click', () => {
      const next = !read();
      this.#prefs.set({ [key]: next } as Partial<Prefs>);
      toggle.classList.toggle('on', next);
      onChange?.();
    });
    head.appendChild(toggle);
    field.appendChild(head);
    this.#prefs.subscribe((_prefs, changed) => {
      if (changed.includes(key)) toggle.classList.toggle('on', read());
    });
    return field;
  }

  /** Выпадающий список для строковой настройки. */
  /**
   * Выбор камеры + кнопка «проверить камеру». Нужно, потому что у ноутбуков их бывает
   * несколько (обычная и ИК для Windows Hello), и на «не той» рук в кадре не будет.
   * Список подтягивается, когда панель открывают: до разрешения метки недоступны.
   */
  #cameraField(): HTMLElement {
    const field = el('div', 'hud-field');
    const head = el('div', 'hud-field-head');
    head.appendChild(el('span', 'hud-label', 'Камера'));
    const select = el('select', 'hud-btn') as HTMLSelectElement;
    select.style.height = '28px';
    select.style.pointerEvents = 'auto';
    select.dataset.role = 'camera';

    const fill = (cameras: { id: string; label: string }[]): void => {
      const current = this.#prefs.get().handCameraId;
      select.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = cameras.length > 1 ? 'по умолчанию (выбрать автоматически)' : 'по умолчанию';
      select.appendChild(auto);
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.id;
        option.textContent = camera.label;
        select.appendChild(option);
      }
      select.value = cameras.some((camera) => camera.id === current) ? current : '';
    };
    fill([]);
    select.addEventListener('change', () => {
      this.#prefs.set({ handCameraId: select.value, handEnabled: true });
    });
    head.appendChild(select);

    const check = el('button', 'hud-btn', 'Проверить камеру');
    check.style.height = '28px';
    check.title = 'Показать превью: сразу видно, что попадает в объектив';
    check.addEventListener('click', () => {
      this.#prefs.set({ handShowPreview: true, handEnabled: true });
      void this.#host.listCameras().then(fill);
    });
    head.appendChild(check);

    field.appendChild(head);
    // Обновляем список каждый раз, когда панель открывают.
    this.#settingsWrap.addEventListener('transitionend', () => void this.#host.listCameras().then(fill));
    const observer = new MutationObserver(() => {
      if (this.#settingsWrap.style.display !== 'none') void this.#host.listCameras().then(fill);
    });
    observer.observe(this.#settingsWrap, { attributes: true, attributeFilter: ['style'] });
    return field;
  }

  #selectField(label: string, key: keyof Prefs, options: [string, string][]): HTMLElement {
    const field = el('div', 'hud-field');
    const head = el('div', 'hud-field-head');
    head.appendChild(el('span', 'hud-label', label));
    const select = el('select', 'hud-btn') as HTMLSelectElement;
    select.style.height = '28px';
    select.style.pointerEvents = 'auto';
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    const sync = () => {
      select.value = String(this.#prefs.get()[key] ?? '');
    };
    sync();
    select.addEventListener('change', () => {
      this.#prefs.set({ [key]: select.value } as Partial<Prefs>);
    });
    this.#prefs.subscribe((_prefs, changed) => {
      if (changed.includes(key)) sync();
    });
    head.appendChild(select);
    field.appendChild(head);
    return field;
  }

  /* ─────────────────────────── Горячие клавиши ─────────────────────────── */

  #bindHotkeys(): void {
    window.addEventListener('keydown', (event) => {
      // Пока открыт диалог подтверждения, горячие клавиши сцен молчат.
      if (this.#modalOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      const code = event.code;
      switch (code) {
        case 'Digit1':
          this.#host.setScene('audio');
          break;
        case 'Digit2':
          this.#host.setScene('network');
          break;
        case 'Digit3':
          this.#host.setScene('disk');
          break;
        case 'KeyG':
          this.#host.toggleHands();
          break;
        case 'KeyM': {
          const module = this.#engine.currentModule;
          module?.onKey?.('KeyM');
          this.refresh();
          break;
        }
        case 'Space':
          event.preventDefault();
          this.#host.togglePause();
          break;
        case 'KeyH':
          this.#host.toggleHud();
          break;
        case 'KeyF':
          this.#host.toggleFullscreen();
          break;
        case 'KeyW':
          this.#host.toggleOutputWindow();
          break;
        case 'KeyS':
          this.#host.toggleSettings();
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  /* ─────────────────────────── Публичное API ─────────────────────────── */

  setScenePanel(panel: HTMLElement | null): void {
    if (this.#scenePanel) this.#scenePanel.remove();
    this.#scenePanel = panel;
    if (panel) this.#scenePanelHost.appendChild(panel);
  }

  toggleSettings(): boolean {
    const visible = this.#settingsWrap.style.display !== 'none';
    this.#settingsWrap.style.display = visible ? 'none' : 'block';
    return !visible;
  }

  setHudVisible(visible: boolean): void {
    this.root.classList.toggle('hud-hidden', !visible);
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="hud"]');
    button?.classList.toggle('active', !visible);
  }

  /** Перерисовать активные вкладки, чипы и подписи режима. */
  refresh(): void {
    const info = this.#host.info();
    for (const [id, button] of this.#tabs) {
      button.classList.toggle('active', id === this.#host.currentScene());
    }
    const prefs = this.#prefs.get();
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="pause"]');
    if (button) {
      button.classList.toggle('active', prefs.paused);
      button.textContent = prefs.paused ? '▶' : '⏸';
    }

    this.#chips[0].textContent = info.os.toUpperCase();
    this.#chips[1].className = `hud-chip ${info.sourceLabel.includes('WASAPI') ? 'on' : ''}`;
    this.#chips[1].textContent = info.sourceLabel;
    this.#chips[2].className = `hud-chip ${info.elevated ? 'on' : 'warn'}`;
    this.#chips[2].textContent = info.elevated ? 'АДМИН' : 'БЕЗ АДМИНА';

    const resolution = this.root.querySelector<HTMLElement>('[data-role="resolution"]');
    const stats = this.#engine.stats;
    if (resolution) resolution.textContent = `${stats.width}×${stats.height} @${stats.pixelRatio.toFixed(2)}`;
    this.#hintEl.dataset.scene = `${info.sceneTitle} · ${info.modeLabel}`;

    const handsButton = this.root.querySelector<HTMLButtonElement>('[data-action="hands"]');
    handsButton?.classList.toggle('active', info.hands);
  }

  /**
   * Строка состояния распознавания рук: «жесты · 30 FPS · GPU · рук: 1 · щипок · захват».
   * `kind` управляет цветом: ok — работает, error — сломалось.
   */
  setHandStatus(text: string, kind: 'ok' | 'error' | '' = ''): void {
    const node = this.#hintEl.querySelector<HTMLElement>('[data-role="hands"]');
    if (!node || node.textContent === text) return;
    node.textContent = text;
    node.classList.toggle('hud-hands-ok', kind === 'ok');
    node.classList.toggle('hud-hands-error', kind === 'error');
  }

  /** Обновление панели статистики (вызывается из app-цикла ~4 раза в секунду). */
  updateStats(): void {
    const stats = this.#engine.stats;
    this.#statsValues.get('fps')!.textContent = stats.fps.toFixed(0);
    this.#statsValues.get('work')!.textContent = `${stats.workMs.toFixed(1)} мс`;
    this.#statsValues.get('frame')!.textContent = `${stats.frameMs.toFixed(1)} мс`;
    this.#statsValues.get('scale')!.textContent = stats.pixelRatio.toFixed(2);
    this.#statsValues.get('calls')!.textContent = String(stats.drawCalls);

    const fpsCell = this.#statsValues.get('fps')!;
    fpsCell.classList.toggle('bad', stats.fps > 1 && stats.fps < 45);
    fpsCell.classList.toggle('good', stats.fps >= 58);
  }

  /** Спарклайн загрузки кадра: рисуем нечасто, чтобы не тратить время кадра. */
  updateSpark(now: number): void {
    const ctx = this.#sparkCtx;
    if (!ctx) return;
    if (now - this.#lastSparkDraw < 100) return;
    this.#lastSparkDraw = now;

    const budget = 16.7;
    const ratio = Math.min(2, this.#engine.stats.workMs / budget);
    this.#sparkData.push(ratio);
    if (this.#sparkData.length > 90) this.#sparkData.shift();

    const { width, height } = this.#spark;
    ctx.clearRect(0, 0, width, height);

    // Линия бюджета 16.7 мс
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, height - height / 2);
    ctx.lineTo(width, height - height / 2);
    ctx.stroke();

    const step = width / Math.max(1, this.#sparkData.length - 1);
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(34, 211, 238, 0.15)');
    gradient.addColorStop(1, 'rgba(34, 211, 238, 0.55)');

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < this.#sparkData.length; i++) {
      const value = Math.min(1.6, this.#sparkData[i]);
      const y = height - (value / 1.6) * (height - 4) - 2;
      ctx.lineTo(i * step, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < this.#sparkData.length; i++) {
      const value = Math.min(1.6, this.#sparkData[i]);
      const y = height - (value / 1.6) * (height - 4) - 2;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * step, y);
    }
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /* ─────────────────────────── Тултип ─────────────────────────── */

  showTooltip(x: number, y: number, title: string, rows: TooltipRow[]): void {
    const rowsHtml = rows
      .map((row) => `<div class="hud-tooltip-row"><span class="k">${escapeHtml(row.k)}</span><span class="v">${escapeHtml(row.v)}</span></div>`)
      .join('');
    this.#tooltip.innerHTML = `<div class="hud-tooltip-title">${escapeHtml(title)}</div>${rowsHtml}`;

    // Не даём тултипу уехать за границы окна.
    const width = this.#tooltip.offsetWidth || 220;
    const clampedX = Math.min(window.innerWidth - width / 2 - 8, Math.max(width / 2 + 8, x));
    this.#tooltip.style.left = `${clampedX}px`;
    this.#tooltip.style.top = `${Math.max(90, y)}px`;
    this.#tooltip.classList.add('visible');
  }

  hideTooltip(): void {
    this.#tooltip.classList.remove('visible');
  }

  /* ─────────────────────────── Модальное окно ─────────────────────────── */

  confirm(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      this.#modalOpen = true;
      const backdrop = el('div', 'hud-modal-backdrop');
      const modal = el('div', 'hud-modal hud-panel');
      modal.innerHTML = `<h3>${escapeHtml(options.title)}</h3><p>${options.message}</p>`;

      const actions = el('div', 'hud-modal-actions');
      const cancel = el('button', 'hud-btn', 'Отмена');
      const confirm = el(
        'button',
        `hud-btn ${options.danger ? 'danger-solid' : 'primary'}`,
        options.confirmLabel ?? 'Подтвердить',
      );
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      this.root.appendChild(backdrop);

      const close = (result: boolean) => {
        this.#modalOpen = false;
        backdrop.remove();
        window.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close(false);
        } else if (event.key === 'Enter') {
          event.stopPropagation();
          close(true);
        }
      };
      window.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close(false);
      });
      confirm.focus();
    });
  }

  /* ─────────────────────────── Тосты ─────────────────────────── */

  toast(
    kind: 'info' | 'warn' | 'error',
    message: string,
    options?: { action?: { label: string; run: () => void } },
  ): void {
    const node = el('div', `hud-toast ${kind}`, escapeHtml(message));
    if (options?.action) {
      const button = el('button', 'hud-btn hud-toast-action', escapeHtml(options.action.label));
      button.addEventListener('click', () => {
        options.action?.run();
        node.remove();
      });
      node.appendChild(button);
    }
    this.#toasts.appendChild(node);
    // Ошибки живут дольше: у них есть кнопка «что делать».
    const lifetime = kind === 'error' ? 9000 : 4200;
    setTimeout(() => {
      node.classList.add('fade');
      setTimeout(() => node.remove(), 420);
    }, lifetime);
  }

  /** Открыть панель настроек (для тостов с кнопкой действия). */
  openSettings(): void {
    this.#settingsWrap.style.display = 'block';
  }

  /* ─────────────────────────── Режимы сцены ─────────────────────────── */

  /** Кнопки режимов внутри панели сцены (используется аудиовизуализатором). */
  buildModeSwitch(
    modes: { id: AudioModeId; label: string; key?: string }[],
    onSelect: (id: AudioModeId) => void,
  ): HTMLElement {
    const wrap = el('div', 'hud-modes');
    this.#modeButtons.clear();
    for (const mode of modes) {
      const button = el('button', 'hud-btn', mode.label);
      button.addEventListener('click', () => {
        onSelect(mode.id);
        this.setActiveMode(mode.id);
      });
      this.#modeButtons.set(mode.id, button);
      wrap.appendChild(button);
    }
    return wrap;
  }

  setActiveMode(id: AudioModeId): void {
    for (const [key, button] of this.#modeButtons) {
      button.classList.toggle('active', key === id);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
