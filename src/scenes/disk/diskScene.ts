/**
 * Сцена 3 — анализатор диска.
 *
 * Два режима одной сцены:
 *  • «город» (основной): каждый объект каталога — здание, высота ∝ размеру,
 *    цвет — категории файлов;
 *  • «sunburst» (альтернативный): кольцевые сектора по уровням вложенности.
 *
 * Удаление — только через подтверждение и только в корзину (Rust: SHFileOperationW
 * с флагом FOF_ALLOWUNDO). Сцена лишь инициирует операцию и анимирует исчезновение.
 */

import * as THREE from 'three';

import { invoke, listen } from '../../core/transport';
import { OrbitCamera } from '../../core/interaction/orbit';
import { NEON, heatPalette } from '../../core/render/materials';
import type { DiskNodeInfo, DiskScanStats } from '../../core/types';
import type { SceneContext, SceneModule, SceneState } from '../../core/scene';

const CATEGORY_COLORS: Record<string, number> = {
  video: 0xf472b6,
  audio: 0xa78bfa,
  image: 0x22d3ee,
  code: 0x34d399,
  archive: 0xfbbf24,
  docs: 0x60a5fa,
  system: 0x94a3b8,
  junk: 0xfb7185,
  dir: 0x38bdf8,
  other: 0x64748b,
};

interface Building {
  node: DiskNodeInfo;
  mesh: THREE.Mesh;
  targetHeight: number;
  /** 0…1 — анимация появления/исчезновения. */
  growth: number;
  dissolving: boolean;
}

export class DiskScene implements SceneModule {
  readonly id = 'disk' as const;
  readonly title = 'Анализатор диска';
  readonly subtitle = 'jwalk → город из файлов';
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  #ctx: SceneContext;
  #orbit: OrbitCamera;
  #detachPointer: (() => void) | null = null;
  #group = new THREE.Group();
  #buildings: Building[] = [];
  #cache = new Map<string, DiskNodeInfo[]>();
  #path: string[] = [];
  #rootPath = '';
  #mode: 'city' | 'sunburst' = 'city';
  #stats: DiskScanStats | null = null;
  #selectedId: number | null = null;
  #ground: THREE.Mesh;
  #activated = false;
  #unlistenStats: (() => void) | null = null;
  #panelBody: HTMLElement | null = null;
  #panelStatus: HTMLElement | null = null;
  #busy = false;
  #hovered: Building | null = null;
  #pointer = { x: 0, y: 0, inside: false };
  #ndc = new THREE.Vector2();
  #labelPool: HTMLElement[] = [];
  #labels: HTMLElement;

  constructor(ctx: SceneContext) {
    this.#ctx = ctx;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.#orbit = new OrbitCamera(this.camera, {
      distance: 120,
      target: new THREE.Vector3(0, 6, 0),
      minDistance: 12,
      maxDistance: 600,
      autoRotate: 0.03,
      minPolar: 0.15,
      maxPolar: Math.PI * 0.48,
    });

    this.scene.add(this.#group);

    // «Земля» города: тёмная плоскость с сеткой и мягким градиентом к краям.
    this.#ground = new THREE.Mesh(
      new THREE.CircleGeometry(260, 96),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uRadius: { value: 260 } },
        vertexShader: /* glsl */ `
          varying vec2 vPos;
          void main() {
            vPos = position.xy;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uEnergy;
          uniform float uRadius;
          varying vec2 vPos;

          void main() {
            float grid = 0.0;
            vec2 cell = abs(fract(vPos / 12.0) - 0.5);
            grid = smoothstep(0.47, 0.5, max(cell.x, cell.y)) * 0.35;
            float distanceToCenter = length(vPos) / uRadius;
            float fade = smoothstep(1.0, 0.15, distanceToCenter);
            vec3 color = vec3(0.05, 0.35, 0.55) * grid + vec3(0.02, 0.05, 0.09) * fade;
            gl_FragColor = vec4(color * (0.7 + uEnergy * 0.6), fade * (0.25 + grid));
          }
        `,
      }),
    );
    this.#ground.rotation.x = -Math.PI / 2;
    this.#ground.position.y = -0.05;
    this.scene.add(this.#ground);

    this.#labels = document.createElement('div');
    this.#labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;font-size:11px;';
    document.body.appendChild(this.#labels);
  }

  /* ─────────────────────────── Жизненный цикл ─────────────────────────── */

  async activate(): Promise<void> {
    if (!this.#activated) {
      const canvas = document.getElementById('viewport');
      if (canvas) this.#detachPointer = this.#orbit.attach(canvas);
      canvas?.addEventListener('pointermove', this.#onPointerMove);
      canvas?.addEventListener('pointerleave', this.#onPointerLeave);
      canvas?.addEventListener('pointerdown', this.#onPointerDown);
      this.#activated = true;
      this.#unlistenStats = listen<DiskScanStats>('vortex://disk/stats', (stats) => this.#onStats(stats));
      const last = await invoke<DiskScanStats>('disk_stats').catch(() => null);
      if (last?.done && last.files > 0) {
        this.#stats = last;
        await this.#load(last.root);
      }
    }
    this.#renderPanel();
  }

  deactivate(): void {
    this.#ctx.hud.hideTooltip();
  }

  modeLabel(): string {
    return this.#mode === 'city' ? 'город' : 'sunburst';
  }

  onKey(code: string): boolean {
    if (code !== 'KeyM') return false;
    this.#mode = this.#mode === 'city' ? 'sunburst' : 'city';
    this.#rebuild();
    this.#renderPanel();
    return true;
  }

  /* ─────────────────────────── Сканирование ─────────────────────────── */

  async #startScan(root?: string): Promise<void> {
    if (this.#busy) return;
    if (this.#ctx.mode === 'output') {
      // В окне вывода сканирование не инициируем: это задача главного окна.
      this.#ctx.toast('info', 'Сканирование запускается в главном окне');
      return;
    }
    this.#busy = true;
    this.#renderPanel();
    try {
      const stats = await invoke<DiskScanStats>('disk_scan', root ? { root } : {});
      this.#stats = stats;
      this.#rootPath = stats?.root ?? root ?? '';
    } catch (err) {
      this.#ctx.toast('error', `Скан не удался: ${String(err)}`);
    } finally {
      this.#busy = false;
    }
  }

  #onStats(stats: DiskScanStats): void {
    this.#stats = stats;
    if (stats.done) {
      this.#busy = false;
      void this.#load(stats.root);
      if (stats.cancelled) this.#ctx.toast('warn', 'Сканирование прервано');
    }
    this.#renderPanel();
  }

  /** Загрузить содержимое каталога (с кэшем) и построить сцену. */
  async #load(path: string): Promise<void> {
    try {
      const children =
        this.#cache.get(path) ?? (await invoke<DiskNodeInfo[]>('disk_children', { path }));
      this.#cache.set(path, children);
      this.#rootPath = path;
      if (!this.#path.length) this.#path = splitPath(path);
      this.#rebuild();
    } catch (err) {
      this.#ctx.toast('warn', `Не удалось прочитать каталог: ${String(err)}`);
    }
  }

  /** Drill-down: клик по папке «раскрывает» её содержимое. */
  async #drillInto(node: DiskNodeInfo): Promise<void> {
    if (!node.isDir) return;
    await this.#load(node.path);
    this.#path = splitPath(node.path);
    this.#selectedId = null;
    this.#renderPanel();
  }

  /* ─────────────────────────── Построение города ─────────────────────────── */

  #rebuild(): void {
    // Освобождаем предыдущую геометрию: у города каждая папка — свой меш.
    for (const building of this.#buildings) {
      this.#group.remove(building.mesh);
      building.mesh.geometry.dispose();
      (building.mesh.material as THREE.Material).dispose();
    }
    this.#buildings = [];

    const children = this.#cache.get(this.#rootPath);
    if (!children || children.length === 0) {
      this.#renderPanel();
      return;
    }

    const top = children.slice(0, 900);
    const maxSize = Math.max(...top.map((child) => child.size), 1);

    if (this.#mode === 'city') this.#layoutCity(top, maxSize);
    else this.#layoutSunburst(top, maxSize);

    this.#renderPanel();
  }

  /** Спиральная упаковка: крупные объекты ближе к центру, мелкие — к окраинам. */
  #layoutCity(nodes: DiskNodeInfo[], maxSize: number): void {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const scaleRadius = 26 + Math.min(nodes.length, 900) * 0.18;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const ratio = Math.pow(node.size / maxSize, 0.42);
      const radius = scaleRadius * Math.sqrt((i + 0.7) / nodes.length);
      const angle = i * golden;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      const width = 1.4 + ratio * 7.5;
      const height = 0.6 + ratio * 60;

      const geometry = new THREE.BoxGeometry(width, 1, width * 0.85);
      geometry.translate(0, 0.5, 0); // точка роста — в основании
      const material = new THREE.MeshBasicMaterial({
        color: this.#colorFor(node),
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, 0, z);
      // Ориентация зданий «лицом» к центру — читается как город.
      mesh.rotation.y = -angle + Math.PI / 2;
      this.#group.add(mesh);

      this.#buildings.push({ node, mesh, targetHeight: height, growth: 0, dissolving: false });
    }
  }

  /** 3D-sunburst: сектора по уровням, яркость по категории. */
  #layoutSunburst(nodes: DiskNodeInfo[], maxSize: number): void {
    const sorted = [...nodes].sort((a, b) => b.size - a.size);
    const total = sorted.reduce((sum, node) => sum + node.size, 0) || 1;
    let angle = 0;
    const inner = 18;
    const outer = 46;

    for (const node of sorted) {
      const span = (node.size / total) * Math.PI * 2;
      const geometry = new THREE.RingGeometry(inner, outer, 96, 1, angle, Math.max(span - 0.004, 0.002));
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0, 0);
      const material = new THREE.MeshBasicMaterial({
        color: this.#colorFor(node),
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Высота уровня — по размеру: крупные сектора «приподняты».
      const height = 0.6 + Math.pow(node.size / maxSize, 0.35) * 22;
      mesh.position.y = height;
      this.#group.add(mesh);
      this.#buildings.push({ node, mesh, targetHeight: height, growth: 0, dissolving: false });
      angle += span;
    }
  }

  #colorFor(node: DiskNodeInfo): number {
    const byPrefs = this.#ctx.prefs.get().diskColorBy;
    if (byPrefs === 'category') return CATEGORY_COLORS[node.category ?? 'other'] ?? CATEGORY_COLORS.other;
    if (byPrefs === 'depth') {
      const depth = this.#path.length % 4;
      const color = new THREE.Color();
      return heatPalette(depth / 3, color).getHex();
    }
    // age: свежие файлы — циан, старые — фиолетовые.
    const age = node.modified ? (Date.now() - node.modified) / (1000 * 60 * 60 * 24 * 365) : 2;
    return NEON.cyan.clone().lerp(NEON.violet, Math.min(1, age / 4)).getHex();
  }

  /* ─────────────────────────── Кадр ─────────────────────────── */

  update(dt: number, time: number, state: SceneState): void {
    const energy = this.#ctx.audio.snapshot.energy;
    (this.#ground.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    (this.#ground.material as THREE.ShaderMaterial).uniforms.uEnergy.value = energy;

    // Анимация появления/исчезновения «зданий».
    for (let i = this.#buildings.length - 1; i >= 0; i--) {
      const building = this.#buildings[i];
      const target = building.dissolving ? 0 : 1;
      building.growth += (target - building.growth) * Math.min(1, dt * 2.6);
      if (building.dissolving && building.growth < 0.02) {
        this.#group.remove(building.mesh);
        building.mesh.geometry.dispose();
        (building.mesh.material as THREE.Material).dispose();
        this.#buildings.splice(i, 1);
        continue;
      }

      const eased = 1 - Math.pow(1 - building.growth, 3);
      if (this.#mode === 'city') {
        building.mesh.scale.y = Math.max(0.001, building.targetHeight * eased);
        // Лёгкое дыхание под бас.
        building.mesh.scale.x = building.mesh.scale.z = 1 + energy * 0.06;
      } else {
        const base = building.targetHeight;
        building.mesh.position.y = base * eased;
        const material = building.mesh.material as THREE.MeshBasicMaterial;
        material.opacity = 0.25 + eased * 0.7;
      }

      if (this.#selectedId === building.node.id) {
        (building.mesh.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      }
    }

    // Наведение.
    if (this.#pointer.inside && !this.#busy) {
      const building = this.#pickBuilding();
      this.#hovered = building;
      if (building) {
        this.#ctx.hud.showTooltip(this.#pointer.x, this.#pointer.y, building.node.name, [
          { k: 'размер', v: formatBytes(building.node.size) },
          { k: 'тип', v: building.node.isDir ? 'каталог' : (building.node.category ?? 'файл') },
          { k: building.node.isDir ? 'файлов' : 'файл', v: building.node.isDir ? String(building.node.files) : building.node.ext || '—' },
        ]);
      } else {
        this.#ctx.hud.hideTooltip();
      }
    }

    this.#orbit.update(dt);
    this.#updateLabels();
    void state;
  }

  /** Поиск здания под курсором: проекция позиций + проверка габаритов. */
  #pickBuilding(): Building | null {
    const projected = new THREE.Vector3();
    let best: Building | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const building of this.#buildings) {
      if (building.growth < 0.3 || building.dissolving) continue;
      const position = building.mesh.position;
      const height =
        this.#mode === 'city' ? building.targetHeight * building.mesh.scale.y : building.targetHeight;
      projected.set(position.x, position.y + height * 0.5, position.z).project(this.camera);
      if (projected.z > 1) continue;
      const distance = Math.hypot(projected.x - this.#ndc.x, projected.y - this.#ndc.y);
      // Экранный радиус зависит от высоты: высокие здания «ловят» курсор охотнее.
      const tolerance = THREE.MathUtils.clamp(0.02 + height * 0.0016, 0.012, 0.08);
      if (distance < tolerance && distance < bestScore) {
        best = building;
        bestScore = distance;
      }
    }
    return best;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.#unlistenStats?.();
    this.#detachPointer?.();
    const canvas = document.getElementById('viewport');
    canvas?.removeEventListener('pointermove', this.#onPointerMove);
    canvas?.removeEventListener('pointerleave', this.#onPointerLeave);
    canvas?.removeEventListener('pointerdown', this.#onPointerDown);
    this.#labels.remove();
    for (const building of this.#buildings) {
      building.mesh.geometry.dispose();
      (building.mesh.material as THREE.Material).dispose();
    }
    this.#ground.geometry.dispose();
    (this.#ground.material as THREE.Material).dispose();
  }

  /* ─────────────────────────── Взаимодействие ─────────────────────────── */

  #onPointerMove = (event: PointerEvent): void => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    this.#pointer.x = event.clientX;
    this.#pointer.y = event.clientY;
    this.#pointer.inside = true;
    this.#ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
  };

  #onPointerLeave = (): void => {
    this.#pointer.inside = false;
    this.#ctx.hud.hideTooltip();
  };

  #onPointerDown = async (): Promise<void> => {
    const building = this.#hovered;
    if (!building) {
      this.#selectedId = null;
      this.#renderPanel();
      return;
    }
    this.#selectedId = building.node.id;
    if (building.node.isDir) {
      await this.#drillInto(building.node);
    } else {
      this.#renderPanel();
    }
  };

  /** Удаление: подтверждение → корзина (Rust) → анимация исчезновения. */
  async #deleteSelected(): Promise<void> {
    const building = this.#buildings.find((item) => item.node.id === this.#selectedId);
    if (!building) return;
    const node = building.node;

    const confirmed = await this.#ctx.confirm({
      title: 'Переместить в корзину?',
      message: `Объект будет удалён <span class="path">${escapeHtml(node.path)}</span><br>Размер: <b>${formatBytes(node.size)}</b>. Восстановить можно из корзины Windows.`,
      confirmLabel: 'В корзину',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await invoke('disk_delete_to_trash', { path: node.path });
      building.dissolving = true;
      this.#cache.delete(this.#rootPath);
      this.#selectedId = null;
      this.#ctx.toast('info', `«${node.name}» перемещён в корзину`);
      // После удаления корневой каталог пересчитывается — подтягиваем свежие данные.
      setTimeout(() => void this.#load(this.#rootPath), 400);
    } catch (err) {
      this.#ctx.toast('error', `Не удалось удалить: ${String(err)}`);
    }
  }

  #updateLabels(): void {
    // Подписи только для выбранного объекта: город и без них читается.
    const building = this.#buildings.find((item) => item.node.id === this.#selectedId);
    if (!building) {
      for (const label of this.#labelPool) label.style.display = 'none';
      return;
    }
    const label = this.#labelPool[0] ?? this.#createLabel();
    const projected = new THREE.Vector3(
      building.mesh.position.x,
      this.#mode === 'city' ? building.targetHeight + 6 : building.targetHeight + 2,
      building.mesh.position.z,
    ).project(this.camera);
    label.style.display = 'block';
    label.style.transform = `translate(${(projected.x * 0.5 + 0.5) * window.innerWidth}px, ${(-projected.y * 0.5 + 0.5) * window.innerHeight - 20}px)`;
    label.textContent = building.node.name;
  }

  #createLabel(): HTMLElement {
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#eaf6ff;font-family:var(--font-mono);' +
      'background:rgba(6,12,22,0.7);border:1px solid rgba(120,200,255,0.25);padding:2px 8px;border-radius:8px;white-space:nowrap;' +
      'text-shadow:0 0 10px rgba(34,211,238,0.8);will-change:transform;';
    this.#labels.appendChild(label);
    this.#labelPool.push(label);
    return label;
  }

  /* ─────────────────────────── Панель HUD ─────────────────────────── */

  hudPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'hud-panel';
    const inner = document.createElement('div');
    inner.className = 'hud-panel-inner';
    panel.appendChild(inner);

    const title = document.createElement('div');
    title.className = 'hud-panel-title';
    title.innerHTML = '<strong>Диск</strong><span class="hud-label">M — город/sunburst</span>';
    inner.appendChild(title);

    const scanRow = document.createElement('div');
    scanRow.className = 'hud-row';
    const scanC = document.createElement('button');
    scanC.className = 'hud-btn primary';
    scanC.textContent = 'Сканировать C:';
    scanC.addEventListener('click', () => void this.#startScan());
    const scanOther = document.createElement('button');
    scanOther.className = 'hud-btn';
    scanOther.textContent = 'Другой каталог…';
    scanOther.addEventListener('click', () => {
      const value = window.prompt('Путь к каталогу для сканирования:', this.#rootPath || 'C:\\');
      if (value) void this.#startScan(value);
    });
    const cancel = document.createElement('button');
    cancel.className = 'hud-btn danger';
    cancel.textContent = 'Стоп';
    cancel.addEventListener('click', () => void invoke('disk_cancel').catch(() => undefined));
    scanRow.append(scanC, scanOther, cancel);
    inner.appendChild(scanRow);

    const status = document.createElement('div');
    status.className = 'hud-field-value';
    status.style.marginTop = '10px';
    status.textContent = 'нет данных — запустите сканирование';
    inner.appendChild(status);
    this.#panelStatus = status;

    const body = document.createElement('div');
    body.className = 'hud-scroll';
    body.style.maxHeight = '34vh';
    body.style.marginTop = '10px';
    inner.appendChild(body);
    this.#panelBody = body;

    this.#renderPanel();
    return panel;
  }

  #renderPanel(): void {
    if (this.#panelStatus) {
      const stats = this.#stats;
      this.#panelStatus.textContent = stats
        ? `${stats.scanning ? 'скан…' : 'готово'} · ${stats.files.toLocaleString('ru-RU')} файлов · ${formatBytes(stats.bytes)} · ${(stats.elapsedMs / 1000).toFixed(1)} с`
        : 'нет данных — запустите сканирование';
    }

    const body = this.#panelBody;
    if (!body) return;
    body.innerHTML = '';

    // Хлебные крошки: спуск/подъём по дереву.
    const crumbs = document.createElement('div');
    crumbs.className = 'hud-row';
    crumbs.style.flexWrap = 'wrap';
    crumbs.style.gap = '4px';
    crumbs.style.marginBottom = '8px';
    this.#path.forEach((part, index) => {
      const button = document.createElement('button');
      button.className = 'hud-btn';
      button.style.height = '24px';
      button.textContent = part;
      button.addEventListener('click', () => {
        const target = this.#path.slice(0, index + 1).join('\\');
        void this.#load(target.endsWith(':') ? `${target}\\` : target);
        this.#path = this.#path.slice(0, index + 1);
      });
      crumbs.appendChild(button);
    });
    body.appendChild(crumbs);

    const children = this.#cache.get(this.#rootPath) ?? [];
    if (children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hud-label';
      empty.textContent = this.#busy ? 'сканирование…' : 'пусто';
      body.appendChild(empty);
      return;
    }

    const selected = children.find((child) => child.id === this.#selectedId);
    if (selected) {
      const details = document.createElement('div');
      details.className = 'hud-panel';
      details.style.padding = '10px 12px';
      details.style.marginBottom = '8px';
      details.innerHTML = `
        <div class="hud-label">${selected.isDir ? 'каталог' : 'файл'}</div>
        <div style="font-size:12.5px;margin:2px 0 6px;word-break:break-all">${escapeHtml(selected.name)}</div>
        <div class="hud-row" style="justify-content:space-between">
          <span class="hud-label">размер</span><span class="hud-mono">${formatBytes(selected.size)}</span>
        </div>`;
      const actions = document.createElement('div');
      actions.className = 'hud-row';
      actions.style.marginTop = '8px';
      if (selected.isDir) {
        const open = document.createElement('button');
        open.className = 'hud-btn';
        open.textContent = 'Открыть';
        open.addEventListener('click', () => void this.#drillInto(selected));
        actions.appendChild(open);
      }
      const remove = document.createElement('button');
      remove.className = 'hud-btn danger';
      remove.textContent = 'В корзину';
      remove.addEventListener('click', () => void this.#deleteSelected());
      actions.appendChild(remove);
      details.appendChild(actions);
      body.appendChild(details);
    }

    // Топ объектов по размеру.
    const top = [...children].sort((a, b) => b.size - a.size).slice(0, 40);
    for (const child of top) {
      const row = document.createElement('div');
      row.className = 'hud-row';
      row.style.cssText = 'font-size:11.5px;padding:2px 0;cursor:pointer;';
      const swatch = document.createElement('span');
      swatch.style.cssText = `width:8px;height:8px;border-radius:2px;flex:none;background:#${
        (CATEGORY_COLORS[child.category ?? 'other'] ?? CATEGORY_COLORS.other).toString(16).padStart(6, '0')
      }`;
      const name = document.createElement('span');
      name.textContent = child.isDir ? `📁 ${child.name}` : child.name;
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      const size = document.createElement('span');
      size.className = 'hud-mono';
      size.style.marginLeft = 'auto';
      size.textContent = formatBytes(child.size);
      row.append(swatch, name, size);
      row.addEventListener('click', () => {
        this.#selectedId = child.id;
        this.#renderPanel();
      });
      row.addEventListener('dblclick', () => {
        if (child.isDir) void this.#drillInto(child);
      });
      body.appendChild(row);
    }
  }
}

/* ─────────────────────────── Хелперы ─────────────────────────── */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map((part, index, all) => {
    // Восстанавливаем «C:\» вместо «C:»
    if (index === 0 && part.endsWith(':') && all.length > 1) return part;
    return part;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
