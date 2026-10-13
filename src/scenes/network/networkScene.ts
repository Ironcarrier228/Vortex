/**
 * Сцена 1 — живая карта сети.
 *
 * Данные: IP Helper API (Rust) → событие `vortex://net/snapshot` → force-directed 3D-граф.
 * Узлы: процессы и удалённые хосты, рёбра: соединения, импульсы: новые подключения.
 *
 * Бонус-режим «глобус»: те же соединения, но удалённые IP раскладываются по
 * географическим координатам, а от локальной точки к ним летят дуги.
 */

import * as THREE from 'three';

import { invoke, listen } from '../../core/transport';
import { OrbitCamera } from '../../core/interaction/orbit';
import { angleDelta } from '../../core/gesture/landmarks';
import {
  ForceGraph,
  HOLE_EJECT_SPEED,
  holeOutcome,
  holeOutcomeLabel,
  type GraphNode,
} from './graph';
import type { NetConnection, NetSnapshot } from '../../core/types';
import type { SceneContext, SceneModule, SceneState } from '../../core/scene';

const GLOBE_RADIUS = 10;
const ARC_SEGMENTS = 28;
const MAX_ARCS = 260;

interface GlobePoint {
  position: THREE.Vector3;
  connection: NetConnection;
  node?: GraphNode;
}

/** Перемещение курсора (в NDC), после которого нажатие считается перетаскиванием. */
const DRAG_TRIGGER_NDC = 0.012;
/** Радиус захвата мышью. */
const GRAB_RADIUS_MOUSE = 0.045;
/**
 * Радиус захвата рукой — заметно больше: палец в воздухе дрожит, поэтому «щипок рядом
 * с узлом» должен узел брать, иначе жест кажется неработающим.
 */
const GRAB_RADIUS_HAND = 0.085;
/** Максимальное удаление узла от центра сцены при перетаскивании (мировые единицы). */
const NODE_DRAG_LIMIT = 190;
/**
 * Скорость (мировые единицы в секунду), при которой отпускание считается **броском**:
 * орб выкинули — перед ним раскрывается чёрная дыра и поглощает его вместе со связями.
 */
const THROW_SPEED_MIN = 52;
/** Чувствительность вращения сцены щипком в пустоте (радианы на единицу NDC). */
const SPACE_ROTATE_SPEED = 2.4;
/** Пределы «сложить всю сцену»: от «в ладони» до «развернуть пошире». */
const SCENE_SCALE_MIN = 0.05;
const SCENE_SCALE_MAX = 1.6;
/** Ниже этого масштаба свёрнутая сцена едет за рукой — «лежит в ладони». */
const SCENE_PALM_SCALE = 0.42;
/** Сколько держать щипок по чёрной дыре, прежде чем из неё вылезет орб (с). */
const HOLE_PULL_DELAY = 0.35;
/** Смещение указателя (NDC), после которого удержание дыры становится растягиванием. */
const HOLE_STRETCH_DRAG = 0.05;
/** Растяжение «на единицу»: 0.22 NDC пути рукой = +1.0 к растяжению. */
const HOLE_STRETCH_PER_NDC = 0.22;
/** На каком расстоянии между щипками двух рук орбы сливаются (NDC). */
const MERGE_DISTANCE_NDC = 0.13;

export class NetworkScene implements SceneModule {
  readonly id = 'network' as const;
  readonly title = 'Карта сети';
  readonly subtitle = 'IP Helper → 3D-граф соединений';
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  #ctx: SceneContext;
  #orbit: OrbitCamera;
  #detachPointer: (() => void) | null = null;
  #graph = new ForceGraph();
  #globe = new THREE.Group();
  #globeActive = false;
  #earth: THREE.Mesh;
  #globePoints: THREE.Points;
  #arcs: THREE.LineSegments;
  #arcPositions: Float32Array;
  #arcPulses: THREE.Points;
  #arcPulsePositions: Float32Array;
  #arcPulseT: number[] = [];
  #globeData: GlobePoint[] = [];
  #origin = new THREE.Vector3(0, GLOBE_RADIUS, 0);
  #originLabel = 'локальный узел';
  #unlisten: (() => void) | null = null;
  #unlisteners: (() => void)[] = [];
  #connections: NetConnection[] = [];
  #snapshot: NetSnapshot | null = null;
  #selected: GraphNode | null = null;
  #hovered: GraphNode | null = null;
  #ndc = new THREE.Vector2();
  #pointer = { x: 0, y: 0, inside: false };
  #labels: HTMLElement;
  #labelPool: HTMLElement[] = [];
  #panelBody: HTMLElement | null = null;
  #panelStats: HTMLElement | null = null;
  #panelMode: HTMLElement | null = null;
  #modeButtons: HTMLButtonElement[] = [];
  #activated = false;
  #statusText = 'ожидание данных…';
  #unsubscribePrefs: (() => void) | null = null;

  // ── Указатель: мышь и рука через общий PointerHub ──
  #pointerOffs: (() => void)[] = [];
  /** Подтверждённое начало перетаскивания (узел уже взят). */
  #dragging = false;
  /** Кандидат на перетаскивание: узел под указателем в момент нажатия/щипка. */
  #dragCandidate: GraphNode | null = null;
  #dragStartNdc = new THREE.Vector2();
  #raycaster = new THREE.Raycaster();
  #dragPlane = new THREE.Plane();
  #dragPoint = new THREE.Vector3();
  #dragOffset = new THREE.Vector3();
  #projected = new THREE.Vector3();
  /** Прошлый поворот кисти: приращение вращает «вырванный» узел. */
  #lastRoll = 0;
  /** Скорость узла в руке: по ней отличаем «положить» от «выбросить». */
  #dragVelocity = new THREE.Vector3();
  #lastDragPoint = new THREE.Vector3();
  #hasDragPoint = false;
  /** Щипок в пустоте: тянем не узел, а саму сцену (вращение и наклон графа). */
  #spaceHold: THREE.Vector2 | null = null;
  #lastSpaceRoll = 0;
  /** Вторая рука: свой орб, своя скорость — двумя руками можно держать два узла. */
  #second = {
    node: null as GraphNode | null,
    plane: new THREE.Plane(),
    offset: new THREE.Vector3(),
    point: new THREE.Vector3(),
    last: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    hasLast: false,
    ndc: new THREE.Vector2(),
  };
  #tempVec = new THREE.Vector3();
  #tempVec2 = new THREE.Vector3();
  #rayNdc = new THREE.Vector2();
  /** Общий масштаб сцены: руками сводим/разводим — сцена сжимается целиком. */
  #sceneScale = 1;
  #sceneScaleTarget = 1;
  /** Якорь свёрнутой сцены: мировая точка, в которой лежит «сцена в ладони». */
  #palm = new THREE.Vector3();
  #palmActive = false;
  /**
   * Режим передачи подключений. Мышь или рука — без разницы: первым щелчком выбираем
   * отдающий орб, вторым — приёмник. Тянуть и целиться не нужно — это и был камень
   * преткновения при перетаскивании руками.
   */
  #pointMode: 'transfer' | 'merge' | null = null;
  #transferSource: GraphNode | null = null;
  #transferButton: HTMLButtonElement | null = null;
  #mergeButton: HTMLButtonElement | null = null;
  /** Растягивание дыры: двумя руками (расстояние между щипками) или перетаскиванием. */
  #stretch: {
    active: boolean;
    baseline: number;
    factor: number;
    warned: { explode: boolean; void: boolean };
  } = { active: false, baseline: 0, factor: 1, warned: { explode: false, void: false } };
  /** Затухание после взрыва/поглощения: экран темнеет, сцена «уходит». */
  #void: HTMLDivElement | null = null;
  /** Пауза после слияния: не даём рукам слить то же самое второй раз подряд. */
  #mergeCooldown = 0;
  /** Сколько секунд растянутая дыра уже без рук: даём жесту миг на возврат, потом решаем. */
  #stretchLost = 0;
  /** Щипок/нажатие по чёрной дыре: держим — она раскрывается и отдаёт орбы по одному. */
  #holePull: {
    active: boolean;
    t: number;
    node: GraphNode | null;
    /** Откуда начали тянуть дыру: по смещению понимаем, что это растягивание, а не выемка орба. */
    pointerStart: { x: number; y: number } | null;
  } = { active: false, t: 0, node: null, pointerStart: null };

  constructor(ctx: SceneContext) {
    this.#ctx = ctx;

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 900);
    this.#orbit = new OrbitCamera(this.camera, {
      distance: 96,
      target: new THREE.Vector3(0, 0, 0),
      minDistance: 18,
      maxDistance: 320,
      autoRotate: 0.045,
      minPolar: 0.3,
      maxPolar: Math.PI - 0.2,
    });

    this.scene.add(this.#graph.object);
    // Подключения вырванного орба забрал сосед — это заметное событие, говорим о нём прямо.
    this.#graph.onTakeOver = (node, foster, links) => {
      this.#updateDiagnostics();
      this.#renderPanel();
      this.#ctx.toast(
        'info',
        `«${node.label}» вырван из цепочки · его подключения (${links}) забрал сосед «${foster.label}»`,
      );
    };
    // Чёрная дыра проглотила орб: говорим об этом прямо и сразу предлагаем вернуть.
    this.#graph.onSwallow = (node, links) => {
      this.#updateDiagnostics();
      this.#renderPanel();
      this.#ctx.toast('info', `Чёрная дыра поглотила «${node.label}» · разорвано связей: ${links}`, {
        action: { label: 'Вернуть узлы', run: () => this.#releaseAllNodes() },
      });
    };
    this.scene.add(this.#globe);
    this.#globe.visible = false;

    // ── Глобус: процедурная «земля» (континенты из шума, сетка координат).
    this.#earth = new THREE.Mesh(
      // 64×48 вместо 96×64: визуально то же, но на слабом GPU вдвое дешевле.
      new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uActive: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vPos;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vPos = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uActive;
          varying vec3 vNormal;
          varying vec3 vPos;

          float hash(vec3 p) {
            return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
          }
          float noise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash(i);
            float n100 = hash(i + vec3(1.0, 0.0, 0.0));
            float n010 = hash(i + vec3(0.0, 1.0, 0.0));
            float n110 = hash(i + vec3(1.0, 1.0, 0.0));
            float n001 = hash(i + vec3(0.0, 0.0, 1.0));
            float n101 = hash(i + vec3(1.0, 0.0, 1.0));
            float n011 = hash(i + vec3(0.0, 1.0, 1.0));
            float n111 = hash(i + vec3(1.0, 1.0, 1.0));
            return mix(
              mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
              mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
              f.z);
          }
          float fbm(vec3 p) {
            // Четыре октавы вместо пяти: континенты выглядят так же, а кадр дешевле
            // (каждая октава — восемь синусов на каждый фрагмент сферы).
            float value = 0.0;
            float amplitude = 0.5;
            for (int i = 0; i < 4; i++) {
              value += amplitude * noise(p);
              p *= 2.05;
              amplitude *= 0.5;
            }
            return value;
          }

          void main() {
            vec3 dir = normalize(vPos);
            float continents = fbm(dir * 2.6);
            float land = smoothstep(0.48, 0.56, continents);

            // Сетка координат (широта/долгота).
            float lat = asin(clamp(dir.y, -1.0, 1.0)) / 3.14159 * 9.0;
            float lon = atan(dir.z, dir.x) / 3.14159 * 18.0;
            float grid = max(
              smoothstep(0.94, 1.0, fract(lat)),
              smoothstep(0.94, 1.0, fract(lon))
            ) * 0.35;

            vec3 ocean = vec3(0.02, 0.05, 0.11);
            vec3 landColor = vec3(0.05, 0.35, 0.42) + vec3(0.15, 0.45, 0.5) * land;
            vec3 color = mix(ocean, landColor, land);
            color += vec3(0.1, 0.6, 0.85) * grid;

            // Объём: подсвечиваем лимб.
            float rim = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 3.0);
            color += vec3(0.15, 0.4, 0.7) * rim * 0.8;
            color += vec3(0.2, 0.5, 0.9) * uActive * 0.08;

            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    );
    this.#earth.rotation.y = -1.2;
    this.#globe.add(this.#earth);

    // Точки удалённых хостов.
    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_ARCS * 3), 3));
    pointsGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_ARCS * 3), 3));
    this.#globePoints = new THREE.Points(
      pointsGeometry,
      new THREE.PointsMaterial({
        size: 0.5,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.#globePoints.frustumCulled = false;
    this.#globe.add(this.#globePoints);

    // Дуги: линии сэмплируются каждый раз при обновлении данных.
    this.#arcPositions = new Float32Array(MAX_ARCS * ARC_SEGMENTS * 6);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute('position', new THREE.BufferAttribute(this.#arcPositions, 3));
    arcGeometry.setDrawRange(0, 0);
    this.#arcs = new THREE.LineSegments(
      arcGeometry,
      new THREE.LineBasicMaterial({
        color: 0x35d6ff,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.#arcs.frustumCulled = false;
    this.#globe.add(this.#arcs);

    // Импульсы, бегущие по дугам.
    this.#arcPulsePositions = new Float32Array(MAX_ARCS * 3).fill(1e6);
    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute('position', new THREE.BufferAttribute(this.#arcPulsePositions, 3));
    this.#arcPulses = new THREE.Points(
      pulseGeometry,
      new THREE.PointsMaterial({
        size: 0.9,
        color: 0xdffbff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.#arcPulses.frustumCulled = false;
    this.#globe.add(this.#arcPulses);

    // Маркер локального узла.
    const originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x9ff0ff }),
    );
    originMarker.name = 'origin-marker';
    this.#globe.add(originMarker);

    // HTML-подписи процессов (проекция в экранные координаты).
    this.#labels = document.createElement('div');
    this.#labels.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:6;font-family:var(--font-mono);font-size:11px;';
    document.body.appendChild(this.#labels);
  }

  /* ─────────────────────────── Жизненный цикл ─────────────────────────── */

  async activate(): Promise<void> {
    if (!this.#activated) {
      const canvas = document.getElementById('viewport');
      if (canvas) this.#detachPointer = this.#orbit.attach(canvas);
      // Сцены больше не слушают мышь напрямую: есть один указатель (мышь или рука).
      this.#pointerOffs.push(
        this.#ctx.pointer.onMove(() => this.#syncPointer()),
        this.#ctx.pointer.onPress(() => this.#onPointerPress()),
        this.#ctx.pointer.onRelease(() => this.#onPointerRelease()),
        this.#ctx.pointer.onClick(() => this.#onPointerClick()),
      );
      window.addEventListener('keydown', this.#onKeyDown);
      this.#unsubscribePrefs = this.#ctx.prefs.subscribe((prefs, changed) => {
        if (changed.includes('networkGlobe')) {
          // Глобус без координат — заведомо пустая сцена: показываем граф и объясняем это.
          if (prefs.networkGlobe && !this.#hasGeoData) {
            this.#ctx.toast(
              'warn',
              'GeoIP ещё не подключён (этап 3): глобус был бы пустым. Открываю граф — ' +
                'он показывает соединения уже сейчас (кнопка «Глобус» заработает после GeoIP).',
            );
            this.#ctx.prefs.set({ networkGlobe: false });
            return;
          }
          this.#setGlobe(prefs.networkGlobe);
        }
        if (changed.includes('networkPollMs')) void invoke('net_start', { pollMs: prefs.networkPollMs });
      });
      this.#activated = true;
    }

    this.#unlisten = listen<NetSnapshot>('vortex://net/snapshot', (snapshot) => this.#onSnapshot(snapshot));
    try {
      const pollMs = this.#ctx.prefs.get().networkPollMs;
      await invoke('net_start', { pollMs });
      const initial = await invoke<NetSnapshot>('net_snapshot');
      if (initial?.connections?.length) this.#onSnapshot(initial);
    } catch (err) {
      this.#ctx.toast('warn', `Опрос сети недоступен: ${String(err)}`);
    }
    this.#setGlobe(this.#ctx.prefs.get().networkGlobe);
  }

  deactivate(): void {
    this.#releaseDrag();
    this.#unlisten?.();
    this.#unlisten = null;
    for (const off of this.#unlisteners) off();
    this.#unlisteners = [];
    void invoke('net_stop').catch(() => undefined);
    this.#ctx.hud.hideTooltip();
  }

  modeLabel(): string {
    return this.#globeActive ? 'глобус' : 'граф';
  }

  onKey(code: string): boolean {
    if (code !== 'KeyM') return false;
    this.#ctx.prefs.set({ networkGlobe: !this.#ctx.prefs.get().networkGlobe });
    return true;
  }

  /* ─────────────────────────── Жесты ─────────────────────────── */

  /**
   * Жест «кулак»: вернуть камеру и снять закрепления узлов.
   * Узлы, которые пользователь расставил руками, возвращаются в физику.
   */
  resetView(): void {
    this.#releaseDrag();
    this.#graph.unpinAll();
    this.#orbit.reset();
  }

  /**
   * Вернуть всё назад (кнопка в панели). Камеру не трогаем: оживают разорванные связи,
   * возвращаются проглоченные чёрной дырой узлы, снимаются закрепления.
   */
  #releaseAllNodes(): void {
    this.#releaseDrag();
    this.#releaseSecond(true);
    this.#graph.unpinAll();
    this.#dragCandidate = null;
    if (!this.#globeActive) this.#graph.sync(this.#connections);
    this.#updateDiagnostics();
    this.#renderPanel();
    this.#ctx.toast('info', 'Узлы возвращены: разорванные связи и проглоченные орбы на месте');
  }

  /**
   * Две руки. Здесь **не зум**: сводим руки — вся сцена (узлы, связи, импульсы, даже
   * чёрная дыра) уменьшается целиком и её можно уместить в ладонь; разводим — разворачивается
   * обратно. Поворот кистей вращает сцену вокруг центра.
   */
  controlScene(step: number, twist: number, center: { x: number; y: number } | null): void {
    this.#sceneScaleTarget = Math.min(SCENE_SCALE_MAX, Math.max(SCENE_SCALE_MIN, this.#sceneScaleTarget * step));
    this.#orbit.rotateBy(twist, 0);
    if (center && this.#sceneScaleTarget < SCENE_PALM_SCALE) {
      this.#palmPoint(center.x, center.y, this.#palm);
      this.#palmActive = true;
    }
  }

  /** Совместимость: мышь зовёт то же самое (зум камеры в этой сцене не используется). */
  controlOrbit(zoom: number, twist: number): void {
    this.controlScene(zoom, twist, null);
  }

  /** Кнопка «Сложить сцену»: собрать всё в ладонь или развернуть обратно. */
  #toggleCollapse(): void {
    this.#sceneScaleTarget = this.#sceneScaleTarget < SCENE_PALM_SCALE ? 1 : 0.08;
    this.#ctx.toast(
      'info',
      this.#sceneScaleTarget < SCENE_PALM_SCALE
        ? 'Сцена складывается в ладонь — свести руки, чтобы удержать её в руке'
        : 'Сцена разворачивается обратно',
    );
  }

  /** Плавно применяем масштаб и ведём свёрнутую сцену за ладонью. */
  #updateSceneScale(dt: number): void {
    if (this.#mergeCooldown > 0) this.#mergeCooldown = Math.max(0, this.#mergeCooldown - dt);
    if (Math.abs(this.#sceneScaleTarget - this.#sceneScale) > 1e-4) {
      this.#sceneScale += (this.#sceneScaleTarget - this.#sceneScale) * Math.min(1, dt * 4.5);
      this.#graph.setGlobalScale(this.#sceneScale);
    }
    // Свёрнутая сцена лежит в руке: тянем её к середине между кистями.
    if (this.#graph.globalScale < SCENE_PALM_SCALE) {
      const two = this.#ctx.gesture.state.twoHand;
      if (two.active) {
        this.#palmPoint(two.centerX, two.centerY, this.#palm);
        this.#graph.setAnchor(this.#palm);
        this.#palmActive = true;
        return;
      }
    }
    if (this.#palmActive) {
      this.#palmActive = false;
      this.#graph.setAnchor(null);
    }
  }

  /** Мировая точка под серединой рук — там, где стоит свёрнутая сцена. */
  #palmPoint(ndcX: number, ndcY: number, out: THREE.Vector3): void {
    this.#rayNdc.set(ndcX, ndcY);
    this.#raycaster.setFromCamera(this.#rayNdc, this.camera);
    const depth = this.camera.position.distanceTo(this.#orbit.target);
    out.copy(this.#raycaster.ray.origin).addScaledVector(this.#raycaster.ray.direction, depth * 0.78);
  }

  /** Жест «класс»: переключить «граф» ↔ «глобус». */
  onGesture(name: string): boolean {
    if (name !== 'thumbs-up') return false;
    this.#ctx.prefs.set({ networkGlobe: !this.#ctx.prefs.get().networkGlobe });
    return true;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (event.code === 'KeyT') {
      this.#toggleTransferMode();
      return;
    }
    if (event.code === 'KeyY') {
      this.#toggleMergeMode();
      return;
    }
    if (event.code === 'Escape') {
      // Сначала выходим из режима передачи, и только потом снимаем выделение.
      if (this.#pointMode) {
        if (this.#transferSource) this.#clearTransferSelection();
        else this.#setPointMode(null);
        return;
      }
      this.#selected = null;
      this.#renderPanel();
    }
  };

  /* ─────────────────────────── Данные ─────────────────────────── */

  #onSnapshot(snapshot: NetSnapshot): void {
    this.#snapshot = snapshot;
    this.#connections = snapshot.connections ?? [];

    // Локальная позиция для глобуса (из настроек; в демо приходит из мок-бэкенда).
    if (snapshot.origin) {
      this.#origin = latLonToVector(snapshot.origin.lat, snapshot.origin.lon, GLOBE_RADIUS * 1.004);
      this.#originLabel = snapshot.origin.label;
      const marker = this.#globe.getObjectByName('origin-marker');
      if (marker) marker.position.copy(this.#origin);
    }

    // Интенсивность: соединение «горячее», если оно только что появилось.
    const added = new Set(snapshot.added ?? []);
    for (const connection of this.#connections) {
      if (added.has(connection.id)) connection.bytesRecv = (connection.bytesRecv ?? 0) + 1;
    }

    if (!this.#globeActive) this.#graph.sync(this.#connections);
    else this.#buildGlobeData();

    const processes = new Set(this.#connections.map((connection) => connection.process)).size;
    const remotes = new Set(this.#connections.map((connection) => connection.remote.ip)).size;
    this.#statusText = `${this.#connections.length} соединений · ${processes} процессов · ${remotes} хостов${
      this.#globeActive ? ` · от ${this.#originLabel}` : ''
    }`;
    this.#updateDiagnostics();
    this.#renderPanel();
  }

  /**
   * Есть ли в снимке хоть одна координата для глобуса. Без GeoIP (этап 3) глобус пуст:
   * на нём остаются только координатная сетка и локальный маркер, и это похоже на «ничего нет».
   */
  get #hasGeoData(): boolean {
    return this.#connections.some(
      (connection) => connection.remote.lat !== undefined && connection.remote.lon !== undefined,
    );
  }

  /**
   * Переключение режима «граф ↔ глобус». В глобус без координат не пускаем: сначала объясняем,
   * почему он будет пустым, и предлагаем вернуться в граф — иначе пользователь видит пустую сцену.
   */
  #requestMode(globe: boolean): void {
    if (globe && !this.#hasGeoData) {
      this.#ctx.toast(
        'warn',
        'GeoIP ещё не подключён (этап 3 — оффлайн-база MaxMind): на глобусе не будет точек хостов, ' +
          'только координатная сетка. Остаюсь в графе — он показывает соединения уже сейчас.',
      );
      this.#ctx.prefs.set({ networkGlobe: false });
      return;
    }
    this.#ctx.prefs.set({ networkGlobe: globe });
  }

  #setGlobe(active: boolean): void {
    this.#globeActive = active;
    this.#globe.visible = active;
    this.#graph.object.visible = !active;
    if (active) {
      this.#buildGlobeData();
      this.#orbit.setDistance(34);
    } else {
      this.#graph.sync(this.#connections);
      this.#orbit.setDistance(96);
    }
    for (const button of this.#modeButtons) {
      button.classList.toggle('active', (button.dataset.mode === 'globe') === active);
    }
    this.#renderPanel();
  }

  /** Разложить удалённые хосты по координатам и подготовить дуги. */
  #buildGlobeData(): void {
    this.#globeData = [];
    const seen = new Set<string>();
    for (const connection of this.#connections) {
      const remote = connection.remote;
      if (remote.lat === undefined || remote.lon === undefined) continue;
      const key = `${remote.ip}:${remote.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.#globeData.push({
        position: latLonToVector(remote.lat, remote.lon, GLOBE_RADIUS * 1.002),
        connection,
      });
      if (this.#globeData.length >= MAX_ARCS) break;
    }

    // Точки хостов.
    const positions = this.#globePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = this.#globePoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const color = new THREE.Color();
    for (let i = 0; i < MAX_ARCS; i++) {
      const point = this.#globeData[i];
      if (!point) {
        positions.setXYZ(i, 0, 1e6, 0);
        continue;
      }
      positions.setXYZ(i, point.position.x, point.position.y, point.position.z);
      // Цвет по порту: web (443/80) — циан, прочее — розовый.
      const web = point.connection.remote.port === 443 || point.connection.remote.port === 80;
      color.set(web ? 0x35d6ff : 0xff7ad1);
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;

    // Дуги от локальной точки к каждому хосту.
    const arcAttribute = this.#arcs.geometry.getAttribute('position') as THREE.BufferAttribute;
    let vertex = 0;
    this.#arcPulseT = [];
    const count = Math.min(this.#globeData.length, MAX_ARCS);
    for (let index = 0; index < count; index++) {
      const target = this.#globeData[index].position;
      // Высота подъёма дуги зависит от расстояния: длинные дуги выше.
      const lift = 1 + this.#origin.distanceTo(target) * 0.16;
      const mid = new THREE.Vector3().addVectors(this.#origin, target).multiplyScalar(0.5).normalize().multiplyScalar(GLOBE_RADIUS + lift);
      const curve = new THREE.QuadraticBezierCurve3(this.#origin, mid, target);
      const samples = curve.getPoints(ARC_SEGMENTS - 1);
      for (let s = 0; s < samples.length - 1; s++) {
        arcAttribute.setXYZ(vertex++, samples[s].x, samples[s].y, samples[s].z);
        arcAttribute.setXYZ(vertex++, samples[s + 1].x, samples[s + 1].y, samples[s + 1].z);
      }
      this.#arcPulseT.push(Math.random());
    }
    arcAttribute.needsUpdate = true;
    this.#arcs.geometry.setDrawRange(0, Math.max(2, vertex));

    (this.#globePoints.material as THREE.PointsMaterial).size = this.#globeActive ? 0.42 : 0.0;
    const marker = this.#globe.getObjectByName('origin-marker');
    if (marker) marker.position.copy(this.#origin);
  }

  /* ─────────────────────────── Кадр ─────────────────────────── */

  update(dt: number, time: number, state: SceneState): void {
    // Курсор: мышь обновляет его событиями, рука — каждый кадр слоем жестов.
    this.#syncPointer();
    this.#updateDrag(dt);
    this.#updateSecondaryHand(dt);
    this.#updateSceneScale(dt);
    this.#updateDropTarget();
    this.#updateStretch(dt);
    this.#updateHandOver();

    if (this.#globeActive) {
      this.#updateGlobe(dt, time);
    } else {
      this.#graph.update(dt, time, this.#selected?.id ?? null, this.camera);
    }
    this.#orbit.update(dt);
    this.#updateLabels();

    // Наведение: пересчитываем под курсором (дёшево — прямая проекция узлов).
    if (!this.#pointer.inside) this.#ctx.hud.hideTooltip();
    if (!this.#globeActive && this.#pointer.inside && !this.#dragging) {
      const node = this.#graph.hitTest(this.camera, this.#ndc.x, this.#ndc.y);
      this.#hovered = node;
      if (node) {
        this.#showTooltip(node);
      } else {
        this.#ctx.hud.hideTooltip();
      }
    }
    void state;
  }

  /** Прочитать состояние общего указателя (мышь или рука) в локальные поля. */
  #syncPointer(): void {
    const pointer = this.#ctx.pointer.state;
    this.#pointer.x = pointer.screenX;
    this.#pointer.y = pointer.screenY;
    this.#pointer.inside = pointer.active && !this.#globeActive;
    this.#ndc.set(pointer.ndcX, pointer.ndcY);
  }

  /* ─────────────────────────── Перетаскивание узлов ─────────────────────────── */

  /**
   * Нажатие (мышь) или щипок (рука). Запоминаем узел-кандидат: перетаскивание начнётся,
   * когда указатель сдвинется, — так обычный клик по узлу остаётся выбором, а не «толчком».
   */
  #onPointerPress(): void {
    if (this.#globeActive) return;
    this.#syncPointer();
    const node = this.#graph.hitTest(this.camera, this.#ndc.x, this.#ndc.y, this.#grabRadius);
    this.#hovered = node;
    this.#dragCandidate = node;
    this.#dragStartNdc.copy(this.#ndc);
  }

  /**
   * Пока орб в руке — ищем орб под указателем: если отпустить здесь, подключения перейдут
   * ему. Приёмник подсвечивается белым, поэтому намерение видно до отпускания.
   */
  #updateDropTarget(): void {
    const node = this.#graph.dragged;
    if (!this.#dragging || !node || this.#globeActive) {
      // В режиме передачи подсвечиваем будущий приёмник под курсором — тот, что выберет щелчок.
      if (this.#pointMode && this.#transferSource && !this.#globeActive) {
        const hovered = this.#hovered;
        const usable = this.#graph.canRewire(this.#transferSource, hovered) ? hovered : null;
        if (this.#graph.dropTarget !== usable) this.#graph.setDropTarget(usable);
        return;
      }
      if (this.#graph.dropTarget) this.#graph.setDropTarget(null);
      return;
    }
    const found = this.#graph.hitTest(this.camera, this.#ndc.x, this.#ndc.y, this.#grabRadius);
    this.#graph.setDropTarget(this.#graph.canRewire(node, found) ? found : null);
  }

  /** Радиус захвата: рукой целимся крупнее, мышью — точнее. */
  get #grabRadius(): number {
    return this.#ctx.pointer.state.source === 'hand' ? GRAB_RADIUS_HAND : GRAB_RADIUS_MOUSE;
  }

  /** Начало фактического перетаскивания: узел закрепляется и следует за указателем. */
  #beginDrag(node: GraphNode): void {
    this.#dragging = true;
    this.#dragCandidate = null;
    this.#dragVelocity.set(0, 0, 0);
    this.#hasDragPoint = false;
    this.#graph.beginDrag(node);
    // «Вырвать из цепочки»: узел раздувается для осмотра, а панель сразу показывает
    // его запросы — пока держим, видно, куда он ходит.
    this.#graph.setBoost(node, 1);
    this.#lastRoll = this.#ctx.gesture.state.roll;
    this.#selected = node;
    this.#renderPanel();
    // Камера не должна крутиться, пока тянем узел мышью.
    this.#orbit.setSuspended(true);
    this.#ctx.gesture.setGrabbed(true);

    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    normal.negate();
    // Узел для плоскости берём в мировых координатах: сцена могла быть свёрнута в ладонь.
    const anchor = this.#graph.nodeWorld(node, new THREE.Vector3());
    this.#dragPlane.setFromNormalAndCoplanarPoint(normal, anchor);

    const hit = this.#pointerOnDragPlane();
    if (hit) this.#dragOffset.copy(anchor).sub(hit);
    else this.#dragOffset.set(0, 0, 0);
  }

  /** Обновление узла под указателем: луч камеры × плоскость, «замороженная» при захвате. */
  #updateDrag(dt: number): void {
    if (this.#dragging) {
      const hit = this.#pointerOnDragPlane();
      if (hit) {
        const point = this.#dragPoint.copy(hit).add(this.#dragOffset);
        // Ограничиваем перемещение сферой вокруг центра: узел не улетает в пустоту.
        if (point.length() > NODE_DRAG_LIMIT) point.setLength(NODE_DRAG_LIMIT);
        // Скорость руки: по ней на отпускании понимаем, что орб не положили, а выкинули.
        if (this.#hasDragPoint && dt > 0.0001) {
          const instant = this.#tempVec.copy(point).sub(this.#lastDragPoint).divideScalar(dt);
          this.#dragVelocity.lerp(instant, Math.min(1, dt * 9));
        }
        this.#lastDragPoint.copy(point);
        this.#hasDragPoint = true;
        this.#graph.moveDragged(point);
        this.#projected.set(point.x, point.y, point.z).project(this.camera);
        this.#ctx.gesture.setTether({
          x: (this.#projected.x * 0.5 + 0.5) * window.innerWidth,
          y: (-this.#projected.y * 0.5 + 0.5) * window.innerHeight,
        });
      }

      // «Покрутить»: поворот кисти вращает рассматриваемый узел.
      const node = this.#graph.dragged;
      if (node) {
        const roll = this.#ctx.gesture.state.roll;
        const delta = angleDelta(this.#lastRoll, roll);
        // Большие скачки — это потеря/перехват руки, а не поворот: их игнорируем.
        if (Math.abs(delta) < 0.7) this.#graph.spinBy(node, delta * 1.8);
        this.#lastRoll = roll;
      }
      return;
    }

    const candidate = this.#dragCandidate;
    const pointer = this.#ctx.pointer.state;
    if (!pointer.pressed) {
      this.#spaceHold = null;
      return;
    }

    // Рукой щипок мог случиться рядом с узлом: пока палец сжат, продолжаем искать узел
    // под курсором и берём первый же — иначе жест выглядит «неработающим».
    if (!candidate) {
      if (pointer.source === 'hand') {
        const node = this.#graph.hitTest(this.camera, this.#ndc.x, this.#ndc.y, GRAB_RADIUS_HAND);
        if (node) {
          this.#hovered = node;
          this.#spaceHold = null;
          this.#beginDrag(node);
          return;
        }
        // Узел не поймали. Чёрная дыра: щипок по ней раскрывает её и вытаскивает орб.
        if (this.#updateHolePull(dt)) return;
        // Иначе щипок в пустоте: тянем саму сцену (граф вращается за рукой).
        this.#holdSpace();
        return;
      }
      // Мышь: узла под курсором не оказалось — возможно, это чёрная дыра.
      this.#updateHolePull(dt);
      return;
    }

    // Обычный путь: указатель сдвинулся достаточно далеко от точки нажатия.
    if (this.#ndc.distanceTo(this.#dragStartNdc) > DRAG_TRIGGER_NDC) this.#beginDrag(candidate);
  }

  #onPointerRelease(): void {
    this.#releaseDrag();
    this.#releaseHole();
    if (this.#stretch.active) this.#finishStretch();
    this.#dragCandidate = null;
  }

  /**
   * Щипок/нажатие по чёрной дыре. Держим — она раскрывается, и через мгновение из неё
   * вылезает случайный проглоченный орб, который дальше едет за рукой (можно унести
   * и оставить где угодно). Повторили — вылез следующий, пока дыра не опустеет.
   */
  #updateHolePull(dt: number): boolean {
    // Дыру растягивают — она занята: не вытаскиваем орб и не перехватываем жест.
    if (this.#stretch.active) return true;
    const pointer = this.#ctx.pointer.state;
    // Рукой берём дыру по её видимому размеру, мышью — тем же щипком (кнопкой).
    const slack = pointer.source === 'hand' ? 0.05 : 0.02;
    if (!this.#holePull.active) {
      if (!this.#graph.hitHole(this.camera, this.#ndc.x, this.#ndc.y, slack)) return false;
      if (!this.#graph.grabHole()) return false;
      this.#holePull = { active: true, t: 0, node: null, pointerStart: { x: this.#ndc.x, y: this.#ndc.y } };
      this.#ctx.toast('info', 'Чёрная дыра раскрылась — держите и тяните: орб вылезет в руку');
      return true;
    }

    this.#holePull.t += dt;
    if (this.#holePull.node) return true;

    if (this.#holePull.t < HOLE_PULL_DELAY) return true;
    const orb = this.#graph.extractOrb();
    if (!orb) {
      this.#ctx.toast('info', 'В чёрной дыре больше ничего нет');
      this.#releaseHole();
      return true;
    }
    this.#holePull.node = orb;
    // Орб вылез из дыры — дальше он ведёт себя как обычный вырванный узел: растёт,
    // показывается в панели и остаётся там, где его отпустят.
    if (!this.#globeActive) this.#graph.sync(this.#connections);
    this.#beginDrag(orb);
    this.#ctx.toast('info', `Из чёрной дыры вылез «${orb.label}» · в дыре осталось: ${this.#graph.dumpCount}`);
    return true;
  }

  /** Отпустили щипок по дыре: если орб не вылез, дыра просто оседает обратно. */
  #releaseHole(): void {
    if (!this.#holePull.active) return;
    this.#holePull = { active: false, t: 0, node: null, pointerStart: null };
    this.#graph.releaseHole();
  }

  /**
   * Отпустить узел: он **остаётся** там, где его оставили (закрепление в d3-force),
   * размер плавно возвращается к обычному. Вернуть всё в физику — кнопкой «Вернуть узлы»
   * или жестом «кулак» (если он включён в настройках).
   */
  #releaseDrag(): void {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#orbit.setSuspended(false);
    const node = this.#graph.dragged;
    const speed = this.#dragVelocity.length();
    const target = this.#graph.dropTarget;
    this.#graph.setDropTarget(null);

    // Отпустили орб НА другом орбе — передаём ему подключения (в любую сторону: что
    // перетащили, то и отдаёт). Приёмник подсвечивался всё время, пока вы целились.
    const rewired =
      node && !this.#globeActive && this.#graph.canRewire(node, target) && target
        ? this.#graph.rewire(node, target)
        : null;

    // Отпустили орб НА чёрной дыре — она забирает его сразу, без разгона: навёл и отпустил.
    let thrown = false;
    if (!rewired && node && !target && !this.#globeActive && this.#graph.hitHole(this.camera, this.#ndc.x, this.#ndc.y, 0.06)) {
      const toHole = this.#tempVec2
        .copy(this.#graph.hole.object.position)
        .applyMatrix4(this.#graph.object.matrixWorld)
        .sub(this.#graph.nodeWorld(node, this.#tempVec));
      const distance = Math.max(1e-3, toHole.length());
      toHole.multiplyScalar((THROW_SPEED_MIN * 1.6) / distance);
      thrown = this.#graph.throwNode(node, toHole);
    }
    // Рывок кистью (или мыши) = бросок: орб выкинули в чёрную дыру.
    if (!rewired && !thrown && node && speed > THROW_SPEED_MIN) {
      thrown = this.#graph.throwNode(node, this.#dragVelocity);
    }
    if (node) this.#graph.setBoost(node, 0);
    this.#graph.endDrag(true, node);
    this.#dragVelocity.set(0, 0, 0);
    this.#hasDragPoint = false;
    this.#ctx.gesture.setGrabbed(false);
    this.#ctx.gesture.setTether(null);

    if (rewired && node && target) {
      if (!this.#globeActive) this.#graph.sync(this.#connections);
      this.#selected = target;
      this.#updateDiagnostics();
      this.#renderPanel();
      this.#ctx.toast(
        'info',
        `«${node.label}» отдал свои подключения (${rewired.moved}) орбу «${target.label}» · ` +
          'перетащите другой орб на этот — будет наоборот',
        { action: { label: 'Обратно', run: () => this.#undoRewire() } },
      );
      return;
    }

    if (thrown && node) {
      this.#ctx.toast(
        'info',
        `Бросок! «${node.label}» улетает в чёрную дыру · разорвано связей: ${this.#requestsOf(node).length}`,
        { action: { label: 'Вернуть узлы', run: () => this.#releaseAllNodes() } },
      );
      return;
    }
    if (node) {
      const requests = this.#requestsOf(node).length;
      this.#ctx.toast(
        'info',
        `Узел «${node.label}» вырван из цепочки и оставлен · запросов: ${requests} · панель слева показывает их`,
      );
    }
  }

  /**
   * Режим передачи подключений. Первый щелчок (или щипок) по орбу — он отдаёт, второй
   * по другому орбу того же типа — принимает. Никакого перетаскивания: рукой достаточно
   * двух уверенных щипков, а подсветка показывает, куда целиться.
   */
  #setPointMode(mode: 'transfer' | 'merge' | null): void {
    if (this.#pointMode === mode) return;
    this.#pointMode = mode;
    this.#clearTransferSelection();
    this.#transferButton?.classList.toggle('active', mode === 'transfer');
    this.#mergeButton?.classList.toggle('active', mode === 'merge');
    this.#ctx.toast(
      'info',
      mode === 'transfer'
        ? 'Режим передачи подключений: щёлкните (или щипните) орб, который отдаёт, затем орб того же типа, который принимает. Esc — выход'
        : mode === 'merge'
          ? 'Режим слияния: щёлкните орб, который растворится, затем орб того же типа, в который он сольётся. Esc — выход'
          : 'Режим указания орбов выключен',
    );
    this.#updateDiagnostics();
    this.#renderPanel();
  }

  #toggleTransferMode(): void {
    this.#setPointMode(this.#pointMode === 'transfer' ? null : 'transfer');
  }

  #toggleMergeMode(): void {
    this.#setPointMode(this.#pointMode === 'merge' ? null : 'merge');
  }

  /**
   * Щелчок по орбу в режиме передачи: первый выбирает отдающего, второй — приёмника.
   * Повторный щелчок по отдающему снимает выбор.
   */
  #transferPick(node: GraphNode | null): boolean {
    const source = this.#transferSource;
    const merge = this.#pointMode === 'merge';

    if (!source) {
      if (!node || node.kind === 'local') {
        this.#ctx.toast('warn', 'Первым выберите орб, у которого забрать подключения (процесс или хост)');
        return true;
      }
      this.#transferSource = node;
      this.#graph.setSourceMark(node);
      this.#graph.setCandidates(
        this.#graph.nodes.filter((candidate) => candidate !== node && this.#graph.canRewire(node, candidate)),
      );
      const count = this.#graph.connectionsOf(node).length;
      this.#ctx.toast(
        'info',
        merge
          ? `«${node.label}» растворится в выбранном орбе · подключений: ${count}. Щёлкните того, в кого сливать`
          : `Отдаёт «${node.label}» · подключений: ${count}. Теперь щёлкните орб того же типа, который примет`,
      );
      this.#renderPanel();
      return true;
    }

    if (!node || node === source) {
      this.#clearTransferSelection();
      this.#ctx.toast('info', 'Выбор снят');
      return true;
    }

    const allowed = merge ? this.#graph.canMerge(source, node) : this.#graph.canRewire(source, node);
    if (!allowed) {
      this.#ctx.toast(
        'warn',
        `«${node.label}» не подходит: нужен орб того же типа (${source.kind === 'process' ? 'процесс' : 'хост'})`,
      );
      return true;
    }

    const from = source;
    const merged = merge ? this.#graph.merge(from, node) : null;
    const result = merge ? null : this.#graph.rewire(from, node);
    this.#clearTransferSelection();
    if (!this.#globeActive) this.#graph.sync(this.#connections);
    this.#selected = node;
    this.#updateDiagnostics();
    this.#renderPanel();

    if (merged) {
      this.#ctx.toast(
        'info',
        `«${merged.label}» слит с «${node.label}» · орбы объединены, подключений теперь ${this.#graph.connectionsOf(node).length}`,
        { action: { label: 'Обратно', run: () => this.#undoRewire() } },
      );
      return true;
    }
    if (result) {
      this.#ctx.toast(
        'info',
        `Подключения (${result.moved}) с «${from.label}» перешли орбу «${node.label}» · выберите следующий орб для ещё одной передачи`,
        { action: { label: 'Обратно', run: () => this.#undoRewire() } },
      );
    }
    return true;
  }

  #clearTransferSelection(): void {
    this.#transferSource = null;
    this.#graph.setSourceMark(null);
    this.#graph.setCandidates(null);
    this.#graph.setDropTarget(null);
    this.#renderPanel();
  }

  /** «Обратно»: подключения возвращаются прежнему орбу — и линии, и владелец в графе. */
  #undoRewire(): void {
    if (!this.#graph.undoRewire()) return;
    if (!this.#globeActive) this.#graph.sync(this.#connections);
    this.#updateDiagnostics();
    this.#renderPanel();
    this.#ctx.toast('info', 'Подключения вернулись к прежнему орбу');
  }

  /**
   * Щипок в пустоте: держим не узел, а саму сцену. Движение руки вращает и наклоняет граф,
   * поворот кисти доворачивает его вокруг оси взгляда — так сценой можно управлять,
   * не отпуская щипок и не трогая мышь.
   */
  #holdSpace(): void {
    // Дыру растягивают — жест занят дырой, сцену под ним не крутим.
    if (this.#stretch.active) return;
    const roll = this.#ctx.gesture.state.roll;
    if (this.#spaceHold) {
      const dx = this.#ndc.x - this.#spaceHold.x;
      const dy = this.#ndc.y - this.#spaceHold.y;
      this.#orbit.rotateBy(-dx * SPACE_ROTATE_SPEED, -dy * SPACE_ROTATE_SPEED);
      const delta = angleDelta(this.#lastSpaceRoll, roll);
      // Большой скачок — потеря/перехват руки, а не поворот: его игнорируем.
      if (Math.abs(delta) < 0.7) this.#orbit.rotateBy(delta * 1.1, 0);
    }
    this.#lastSpaceRoll = roll;
    this.#spaceHold = new THREE.Vector2(this.#ndc.x, this.#ndc.y);
  }

  /**
   * Вторая рука: свой щипок держит свой орб, рывок — свой бросок. Двумя руками можно
   * развести два узла и сравнить их запросы (панель показывает последний взятый).
   */
  #updateSecondaryHand(dt: number): void {
    const gesture = this.#ctx.gesture.state;
    const cursor = gesture.secondaryCursor;

    if (this.#globeActive || !cursor.active) {
      this.#releaseSecond(true);
      return;
    }

    const node = this.#second.node;
    if (!node) {
      if (!gesture.secondaryPinch || this.#dragging) return;
      this.#second.ndc.set(cursor.ndcX, cursor.ndcY);
      const found = this.#graph.hitTest(this.camera, this.#second.ndc.x, this.#second.ndc.y, GRAB_RADIUS_HAND);
      // Один и тот же орб двумя руками не тянем: вторая рука берёт только свободный узел.
      if (!found || this.#graph.grabbedNodes.includes(found)) return;
      this.#second.node = found;
      this.#second.velocity.set(0, 0, 0);
      this.#second.hasLast = false;
      this.#graph.beginDrag(found);
      this.#graph.setBoost(found, 1);
      this.#ctx.gesture.setGrabbed(true);
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      normal.negate();
      const anchor = new THREE.Vector3(found.x ?? 0, found.y ?? 0, found.z ?? 0);
      this.#second.plane.setFromNormalAndCoplanarPoint(normal, anchor);
      const hit = this.#secondOnPlane();
      if (hit) this.#second.offset.copy(anchor).sub(this.#second.point);
      else this.#second.offset.set(0, 0, 0);
      return;
    }

    if (!gesture.secondaryPinch) {
      this.#releaseSecond(false);
      return;
    }

    this.#second.ndc.set(cursor.ndcX, cursor.ndcY);

    // Две руки держат два орба и сводят их вместе — это слияние: орбы становятся одним.
    const primary = this.#graph.dragged;
    if (primary && primary !== node && this.#graph.canMerge(node, primary)) {
      const distance = Math.hypot(
        this.#ctx.gesture.state.cursor.ndcX - cursor.ndcX,
        this.#ctx.gesture.state.cursor.ndcY - cursor.ndcY,
      );
      if (distance < MERGE_DISTANCE_NDC && this.#mergeCooldown <= 0) {
        const merged = this.#graph.merge(node, primary);
        if (merged) {
          this.#mergeCooldown = 1.2;
          this.#second.node = null;
          this.#graph.setBoost(node, 0);
          this.#graph.endDrag(true, node);
          this.#second.hasLast = false;
          if (!this.#globeActive) this.#graph.sync(this.#connections);
          this.#selected = primary;
          this.#updateDiagnostics();
          this.#renderPanel();
          this.#ctx.toast(
            'info',
            `Орбы слились: «${merged.label}» растворился в «${primary.label}» · подключений теперь ${this.#graph.connectionsOf(primary).length}`,
            { action: { label: 'Обратно', run: () => this.#undoRewire() } },
          );
          return;
        }
      }
    }

    const hit = this.#secondOnPlane();
    if (!hit) return;
    const point = this.#second.point.copy(hit).add(this.#second.offset);
    if (point.length() > NODE_DRAG_LIMIT) point.setLength(NODE_DRAG_LIMIT);
    if (this.#second.hasLast && dt > 0.0001) {
      const instant = this.#tempVec.copy(point).sub(this.#second.last).divideScalar(dt);
      this.#second.velocity.lerp(instant, Math.min(1, dt * 9));
    }
    this.#second.last.copy(point);
    this.#second.hasLast = true;
    this.#graph.moveDragged(point, node);
  }

  /** Луч второй руки × её плоскость перетаскивания. */
  #secondOnPlane(): THREE.Vector3 | null {
    this.#raycaster.setFromCamera(this.#second.ndc, this.camera);
    return this.#raycaster.ray.intersectPlane(this.#second.plane, this.#second.point);
  }

  /** Отпустить орб второй руки; `quiet` — без броска (рука ушла, сцена вернулась к графу). */
  #releaseSecond(quiet: boolean): void {
    const node = this.#second.node;
    this.#second.node = null;
    if (!node) return;
    const speed = this.#second.velocity.length();

    // Вторая рука тоже умеет передавать подключения: отпустили орб на другом орбе.
    if (!quiet) {
      const target = this.#graph.hitTest(this.camera, this.#second.ndc.x, this.#second.ndc.y, GRAB_RADIUS_HAND);
      const usable = this.#graph.canRewire(node, target) ? target : null;
      if (usable) {
        const moved = this.#graph.rewire(node, usable);
        if (moved) {
          this.#graph.setBoost(node, 0);
          this.#graph.endDrag(true, node);
          this.#second.velocity.set(0, 0, 0);
          this.#second.hasLast = false;
          if (!this.#dragging) this.#ctx.gesture.setGrabbed(false);
          if (!this.#globeActive) this.#graph.sync(this.#connections);
          this.#selected = usable;
          this.#updateDiagnostics();
          this.#renderPanel();
          this.#ctx.toast(
            'info',
            `Вторая рука: «${node.label}» отдал подключения (${moved.moved}) орбу «${usable.label}»`,
            { action: { label: 'Обратно', run: () => this.#undoRewire() } },
          );
          return;
        }
      }
    }
    const thrown = !quiet && speed > THROW_SPEED_MIN ? this.#graph.throwNode(node, this.#second.velocity) : false;
    this.#graph.setBoost(node, 0);
    this.#graph.endDrag(true, node);
    this.#second.velocity.set(0, 0, 0);
    this.#second.hasLast = false;
    if (!this.#dragging) this.#ctx.gesture.setGrabbed(false);
    if (thrown) {
      this.#ctx.toast('info', `Второй орб «${node.label}» тоже улетел в чёрную дыру`, {
        action: { label: 'Вернуть узлы', run: () => this.#releaseAllNodes() },
      });
    }
  }

  /** Запросы (соединения), которые идут через узел: процесс → его соединения, хост → кто к нему ходит. */
  #requestsOf(node: GraphNode): NetConnection[] {
    return this.#connections.filter(
      (connection) =>
        (node.kind === 'process' && connection.process === node.process) ||
        (node.kind === 'remote' && connection.remote.ip === node.ip),
    );
  }

  /** Короткое нажатие = выбор узла (мышью или щипком). */
  /**
   * Растягивание чёрной дыры. Двумя руками: щипок на дыре обеими руками и разводим —
   * расстояние между кистями задаёт растяжение. Одной рукой (или мышью): взяли дыру
   * и потянули в сторону. Пока тянем, дыра ест всё, что попало за горизонт событий,
   * а отпускание решает судьбу: схлопнуть (вернёт орбы), взорвать (орбы разлетаются)
   * или поглотить всё.
   */
  #updateStretch(dt: number): void {
    const gesture = this.#ctx.gesture.state;
    const pointer = this.#ctx.pointer.state;
    const twoHands =
      gesture.pinch.active && gesture.secondaryPinch && gesture.secondaryCursor.active;

    if (!this.#stretch.active) {
      const onHole = (x: number, y: number): boolean => this.#graph.hitHole(this.camera, x, y, 0.06);
      // Две руки щиплют дыру — классический жест «развести руками».
      const bothOnHole =
        twoHands &&
        onHole(gesture.cursor.ndcX, gesture.cursor.ndcY) &&
        onHole(gesture.secondaryCursor.ndcX, gesture.secondaryCursor.ndcY);
      // Одна рука или мышь: держим дыру и тянем. Орб в руке — не растягиваем: там другой жест.
      const anchor = this.#holePull.pointerStart ?? this.#dragStartNdc;
      const holding =
        !this.#dragging &&
        this.#holePull.node === null &&
        (this.#holePull.active || (pointer.pressed && onHole(this.#ndc.x, this.#ndc.y)));
      const pulled =
        holding && Math.hypot(this.#ndc.x - anchor.x, this.#ndc.y - anchor.y) > HOLE_STRETCH_DRAG;
      if (!bothOnHole && !pulled) return;

      this.#stretch = { active: true, baseline: 0, factor: 1, warned: { explode: false, void: false } };
      this.#stretchLost = 0;
      this.#spaceHold = null;
      this.#orbit.setSuspended(true);
      if (!this.#graph.hole.alive) {
        this.#graph.hole.open(this.#holeAnchorPoint(), this.#graph.hole.radius || 5);
      }
      this.#graph.hole.hold(true);
      this.#ctx.toast(
        'info',
        'Чёрная дыра растягивается! Разведите руки: немного — схлопнется и вернёт орбы, сильнее — ' +
          'взорвётся, на максимуме — поглотит всё. Отпустите, когда решите.',
      );
    }

    // Растяжение: двумя руками — расстояние между щипками, одной/мышью — путь от точки захвата.
    let handsNow = false;
    if (twoHands) {
      const distance = Math.hypot(
        gesture.cursor.ndcX - gesture.secondaryCursor.ndcX,
        gesture.cursor.ndcY - gesture.secondaryCursor.ndcY,
      );
      if (this.#stretch.baseline === 0) this.#stretch.baseline = Math.max(0.08, distance);
      this.#stretch.factor = distance / this.#stretch.baseline;
      handsNow = true;
    } else if (this.#holePull.active || pointer.pressed) {
      const anchor = this.#holePull.pointerStart ?? this.#dragStartNdc;
      const travel = Math.hypot(this.#ndc.x - anchor.x, this.#ndc.y - anchor.y);
      this.#stretch.factor = 1 + Math.max(0, travel - HOLE_STRETCH_DRAG) / HOLE_STRETCH_PER_NDC;
    }

    const factor = Math.max(1, this.#stretch.factor);
    this.#stretch.factor = factor;
    this.#graph.hole.setStretch(factor);
    // Дыру взяли тянуть — вытаскивание орба в этот раз отменяется (жест занят растяжением).
    if (this.#holePull.node === null) this.#holePull.t = 0;

    // Растянутая дыра ест всё, что попало за горизонт событий: это и есть «всё поглотит».
    const eaten = this.#graph.absorbNearby(this.#graph.hole.radius * 1.05);
    if (eaten.length > 0) this.#graph.sync(this.#connections);

    const voidEnabled = this.#ctx.prefs.get().holeVoid;
    const outcome = holeOutcome(factor, voidEnabled);
    if (outcome !== 'collapse' && !this.#stretch.warned.explode) {
      this.#stretch.warned.explode = true;
      this.#ctx.toast('warn', 'Ещё немного — и дыра взорвётся: орбы разлетятся по сцене');
    }
    if (outcome === 'void' && !this.#stretch.warned.void) {
      this.#stretch.warned.void = true;
      this.#ctx.toast(
        'error',
        'ОПАСНО: на таком размере дыра поглотит всё, и приложение закроется. Отпустите сейчас — или тяните до конца',
      );
    }
    this.#updateDiagnostics();

    // Отпускание: руки разжались или указатель отпущен. Кисть на миг теряется — ждём 0.3 с.
    const held = handsNow || this.#holePull.active || pointer.pressed;
    this.#stretchLost = held ? 0 : this.#stretchLost + dt;
    if (!held && this.#stretchLost > 0.3) this.#finishStretch();
  }

  /**
   * Две руки разом: одна держит орб, вторая щипнула чёрную дыру — орб уходит за горизонт
   * без рывка кистью. Раньше это приходилось делать броском; теперь достаточно показать
   * дыре, что с орбом делать.
   */
  #updateHandOver(): void {
    const gesture = this.#ctx.gesture.state;
    const node = this.#graph.dragged;
    // Орб должен быть в первой руке, а не в той, что уже что-то держит, и не на глобусе.
    if (!node || node === this.#second.node || this.#globeActive) return;
    if (!gesture.secondaryPinch || !gesture.secondaryCursor.active) return;
    if (
      !this.#graph.hitHole(
        this.camera,
        gesture.secondaryCursor.ndcX,
        gesture.secondaryCursor.ndcY,
        0.06,
      )
    ) {
      return;
    }

    const toHole = this.#tempVec2
      .copy(this.#graph.hole.object.position)
      .applyMatrix4(this.#graph.object.matrixWorld)
      .sub(this.#graph.nodeWorld(node, this.#tempVec));
    const distance = Math.max(1e-3, toHole.length());
    toHole.multiplyScalar((THROW_SPEED_MIN * 1.6) / distance);
    if (!this.#graph.throwNode(node, toHole)) return;
    this.#releaseSecond(true);
    this.#releaseDrag();
    this.#ctx.toast('info', `«${node.label}» ушёл в чёрную дыру: вторая рука указала, куда его`);
  }

  /** Где сейчас дыра в мировых координатах (для повторного раскрытия). */
  #holeAnchorPoint(): THREE.Vector3 {
    return this.#tempVec2.copy(this.#graph.hole.object.position).applyMatrix4(this.#graph.object.matrixWorld);
  }

  /** Отпустили растянутую дыру: схлопываем, взрываем или поглощаем всё. */
  #finishStretch(): void {
    if (!this.#stretch.active) return;
    const factor = this.#stretch.factor;
    const voidEnabled = this.#ctx.prefs.get().holeVoid;
    const outcome = holeOutcome(factor, voidEnabled);
    this.#stretch = { active: false, baseline: 0, factor: 1, warned: { explode: false, void: false } };
    this.#stretchLost = 0;
    if (!this.#dragging) this.#orbit.setSuspended(false);
    this.#graph.hole.setStretch(1);

    if (outcome === 'collapse') {
      const returned = this.#graph.ejectAll(0);
      this.#graph.hole.close();
      this.#graph.sync(this.#connections);
      this.#updateDiagnostics();
      this.#renderPanel();
      this.#ctx.toast(
        'info',
        returned.length
          ? `Дыра схлопнулась и вернула орбы: ${returned.length}`
          : 'Дыра схлопнулась: внутри ничего не было',
      );
      return;
    }

    if (outcome === 'explode') {
      const blown = this.#graph.ejectAll(HOLE_EJECT_SPEED);
      this.#graph.hole.explode();
      this.#graph.sync(this.#connections);
      this.#updateDiagnostics();
      this.#renderPanel();
      this.#ctx.toast(
        'info',
        `Дыра взорвалась: орбы (${blown.length}) разлетелись по сцене и остались там, где остановились`,
      );
      return;
    }

    // Крайний исход: поглощает всё, что осталось, и приложение закрывается (или сцена
    // перезапускается в браузере — там окно закрыть нельзя).
    this.#graph.absorbEverything();
    this.#graph.hole.explode();
    this.#updateDiagnostics();
    this.#beginVoid();
  }

  /**
   * «Всё поглощено»: сцена уходит в темноту, а дальше — либо закрытие приложения
   * (Tauri), либо кнопка «Начать заново» в браузере. Это необратимо, поэтому решение
   * принимает пользователь растяжением, а не случайный жест.
   */
  #beginVoid(): void {
    if (!this.#void) {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:#000;opacity:0;transition:opacity 1.6s ease;' +
        'z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:18px;font-family:var(--font-mono,monospace);color:#ffd9a0;text-align:center;pointer-events:none';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:22px;letter-spacing:0.22em;text-transform:uppercase';
      title.textContent = 'Чёрная дыра поглотила всё';
      const note = document.createElement('div');
      note.style.cssText = 'font-size:13px;color:#9a8fb0';
      note.textContent = 'соединения, процессы и хосты ушли за горизонт событий';
      const restart = document.createElement('button');
      restart.className = 'hud-btn';
      restart.style.pointerEvents = 'auto';
      restart.textContent = 'Начать заново';
      restart.addEventListener('click', () => window.location.reload());
      overlay.append(title, note, restart);
      document.body.appendChild(overlay);
      this.#void = overlay;
    }
    const overlay = this.#void;
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.style.pointerEvents = 'auto';
    });

    // В приложении окно действительно закрывается: сначала даём сцене уйти в темноту.
    window.setTimeout(() => {
      void invoke('app_quit').catch((err) => console.warn('[network] закрытие приложения:', err));
    }, 2600);
  }

  #onPointerClick(): void {
    if (this.#dragging) return;
    // В режиме передачи короткий щипок/клик не выбирает узел, а назначает отдающего и приёмника.
    if (this.#pointMode && this.#transferPick(this.#globeActive ? null : this.#hovered)) return;
    if (this.#globeActive || !this.#hovered) {
      this.#selected = null;
      this.#renderPanel();
      return;
    }
    this.#selected = this.#selected?.id === this.#hovered.id ? null : this.#hovered;
    this.#renderPanel();
  }

  #pointerOnDragPlane(): THREE.Vector3 | null {
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    return this.#raycaster.ray.intersectPlane(this.#dragPlane, this.#dragPoint);
  }

  #updateGlobe(dt: number, time: number): void {
    this.#earth.rotation.y += dt * 0.02;
    (this.#earth.material as THREE.ShaderMaterial).uniforms.uTime.value = time;

    // Импульсы по дугам: каждая точка «бежит» по своей кривой.
    const attribute = this.#arcPulses.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = Math.min(this.#globeData.length, MAX_ARCS);
    for (let index = 0; index < count; index++) {
      this.#arcPulseT[index] = (this.#arcPulseT[index] ?? Math.random()) + dt * (0.35 + (index % 5) * 0.05);
      if (this.#arcPulseT[index] > 1) this.#arcPulseT[index] = 0;
      const t = this.#arcPulseT[index];
      // Приблизительно: интерполируем между двумя сэмплами дуги.
      const base = index * ARC_SEGMENTS * 2;
      const sampleIndex = Math.min(ARC_SEGMENTS - 2, Math.floor(t * (ARC_SEGMENTS - 1)));
      const a = new THREE.Vector3(
        this.#arcPositions[(base + sampleIndex * 2) * 3],
        this.#arcPositions[(base + sampleIndex * 2) * 3 + 1],
        this.#arcPositions[(base + sampleIndex * 2) * 3 + 2],
      );
      const b = new THREE.Vector3(
        this.#arcPositions[(base + sampleIndex * 2 + 1) * 3],
        this.#arcPositions[(base + sampleIndex * 2 + 1) * 3 + 1],
        this.#arcPositions[(base + sampleIndex * 2 + 1) * 3 + 2],
      );
      const local = (t * (ARC_SEGMENTS - 1)) % 1;
      const point = a.lerp(b, local);
      attribute.setXYZ(index, point.x, point.y, point.z);
    }
    for (let index = count; index < MAX_ARCS; index++) attribute.setXYZ(index, 0, 1e6, 0);
    attribute.needsUpdate = true;

    // Лёгкое «дыхание» дуг под музыку, если играет аудио.
    const energy = this.#ctx.audio.snapshot.energy;
    (this.#arcs.material as THREE.LineBasicMaterial).opacity = 0.28 + energy * 0.5;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.deactivate();
    this.#detachPointer?.();
    for (const off of this.#pointerOffs) off();
    this.#pointerOffs = [];
    window.removeEventListener('keydown', this.#onKeyDown);
    this.#unsubscribePrefs?.();
    this.#labels.remove();
    this.#graph.dispose();
    this.#earth.geometry.dispose();
    (this.#earth.material as THREE.Material).dispose();
    this.#arcs.geometry.dispose();
    (this.#arcs.material as THREE.Material).dispose();
    this.#arcPulses.geometry.dispose();
    (this.#arcPulses.material as THREE.Material).dispose();
    this.#globePoints.geometry.dispose();
    (this.#globePoints.material as THREE.Material).dispose();
  }

  /* ─────────────────────────── Взаимодействие ─────────────────────────── */

  #showTooltip(node: GraphNode): void {
    const rows =
      node.kind === 'process'
        ? [
            { k: 'PID', v: String(node.pid ?? '—') },
            { k: 'соединений', v: String(this.#connections.filter((c) => c.process === node.process).length) },
          ]
        : node.kind === 'remote'
          ? [
              { k: 'IP', v: node.ip ?? '—' },
              { k: 'порт', v: String(node.port ?? '—') },
              { k: 'протокол', v: (node.protocol ?? '—').toUpperCase() },
              { k: 'гео', v: [node.city, node.country].filter(Boolean).join(', ') || 'нет GeoIP' },
            ]
          : [
              { k: 'роль', v: 'машина-источник' },
              { k: 'соединений', v: String(this.#connections.length) },
            ];
    this.#ctx.hud.showTooltip(this.#pointer.x, this.#pointer.y, node.label, rows);
  }

  /** Подписи процессов: проецируем позиции узлов в экранные координаты. */
  #updateLabels(): void {
    if (!this.#ctx.prefs.get().networkLabels || this.#globeActive) {
      if (this.#labelPool.length) for (const label of this.#labelPool) label.style.display = 'none';
      return;
    }
    const candidates = this.#graph.nodes
      .filter((node) => node.kind === 'process')
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 14);

    const width = window.innerWidth;
    const height = window.innerHeight;
    const projected = new THREE.Vector3();

    for (let i = 0; i < candidates.length; i++) {
      const label = this.#labelPool[i] ?? this.#createLabel();
      const node = candidates[i];
      projected.set(node.x ?? 0, node.y ?? 0, node.z ?? 0).project(this.camera);
      const onScreen = projected.z < 1;
      label.style.display = onScreen ? 'block' : 'none';
      if (!onScreen) continue;
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      label.style.transform = `translate(${x}px, ${y - 22}px)`;
      label.textContent = node.label;
      label.style.opacity = String(0.25 + node.intensity * 0.75);
    }
    for (let i = candidates.length; i < this.#labelPool.length; i++) this.#labelPool[i].style.display = 'none';
  }

  #createLabel(): HTMLElement {
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;left:0;top:0;transform:translate(-50%,-100%);color:#d8f4ff;' +
      'text-shadow:0 0 12px rgba(34,211,238,0.9);white-space:nowrap;will-change:transform;' +
      'padding:1px 6px;border-radius:6px;background:rgba(6,12,22,0.45);';
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
    title.innerHTML = '<strong>Соединения</strong><span class="hud-label">M — граф/глобус</span>';
    inner.appendChild(title);

    const status = document.createElement('div');
    status.className = 'hud-field-value';
    status.textContent = this.#statusText;
    inner.appendChild(status);
    this.#panelStats = status;

    const modes = document.createElement('div');
    modes.className = 'hud-modes';
    modes.style.marginTop = '10px';
    this.#modeButtons = [];
    for (const [id, label] of [
      ['graph', 'Граф'],
      ['globe', 'Глобус'],
    ] as const) {
      const button = document.createElement('button');
      button.className = 'hud-btn';
      button.textContent = label;
      button.dataset.mode = id;
      button.addEventListener('click', () => this.#requestMode(id === 'globe'));
      this.#modeButtons.push(button);
      modes.appendChild(button);
    }
    inner.appendChild(modes);

    // Вернуть расстановку: узлы, которые «вырвали» и оставили, снова ловит физика.
    const returnRow = document.createElement('div');
    returnRow.className = 'hud-modes';
    returnRow.style.marginTop = '6px';

    // Режим передачи подключений: включил, щёлкнул отдающий орб, щёлкнул приёмник.
    const transferButton = document.createElement('button');
    transferButton.className = 'hud-btn';
    transferButton.dataset.action = 'transfer';
    transferButton.textContent = 'Передать подключения';
    transferButton.title =
      'Режим передачи: щёлкните орб, который отдаёт, затем орб того же типа, который принимает (T)';
    transferButton.addEventListener('click', () => this.#toggleTransferMode());
    returnRow.appendChild(transferButton);
    this.#transferButton = transferButton;

    // Слияние орбов: процессы (или хосты) становятся одним орбом с общими подключениями.
    const mergeButton = document.createElement('button');
    mergeButton.className = 'hud-btn';
    mergeButton.dataset.action = 'merge';
    mergeButton.textContent = 'Слить орбы';
    mergeButton.title = 'Режим слияния: щёлкните орб, который растворится, затем того, в кого сливать (Y)';
    mergeButton.addEventListener('click', () => this.#toggleMergeMode());
    returnRow.appendChild(mergeButton);
    this.#mergeButton = mergeButton;

    const collapseButton = document.createElement('button');
    collapseButton.className = 'hud-btn';
    collapseButton.textContent = 'Сложить сцену';
    collapseButton.title = 'Сжать всю сцену целиком (не зум камеры) — тем же жестом это делают две руки';
    collapseButton.addEventListener('click', () => this.#toggleCollapse());
    returnRow.appendChild(collapseButton);

    const returnButton = document.createElement('button');
    returnButton.className = 'hud-btn';
    returnButton.textContent = 'Вернуть узлы';
    returnButton.title = 'Снять закрепления: все вырванные узлы возвращаются в раскладку';
    returnButton.addEventListener('click', () => this.#releaseAllNodes());
    returnRow.appendChild(returnButton);
    inner.appendChild(returnRow);

    // Строка диагностики 3D: сразу видно, дошли ли данные до сцены и какой режим активен.
    const mode = document.createElement('div');
    mode.className = 'hud-label';
    mode.style.marginTop = '8px';
    inner.appendChild(mode);
    this.#panelMode = mode;

    const body = document.createElement('div');
    body.className = 'hud-scroll';
    body.style.maxHeight = '32vh';
    body.style.marginTop = '12px';
    inner.appendChild(body);
    this.#panelBody = body;

    // Ссылка на список обновляется при каждом снимке — панель всегда актуальна.
    this.#renderPanel();
    return panel;
  }

  /** Что реально попало в 3D: узлы, рёбра и активный режим. */
  #updateDiagnostics(): void {
    if (!this.#panelMode) return;
    if (this.#globeActive) {
      const points = this.#globeData.length;
      this.#panelMode.textContent = points
        ? `в 3D: глобус · ${points} хостов с координатами`
        : 'в 3D: глобус · нет координат (GeoIP — этап 3)';
      return;
    }
    // Что пользователь сделал руками: передал связи соседям, выкинул орбы в дыру.
    const handed = this.#graph.takeoverCount;
    const inHole = this.#graph.dumpCount;
    const scale = Math.round(this.#graph.globalScale * 100);
    const parts: string[] = [];
    if (handed) parts.push(`связи у соседей: ${handed}`);
    const rewired = this.#graph.rewireCount;
    if (rewired) parts.push(`передано руками: ${rewired}`);
    if (this.#pointMode) {
      const what = this.#pointMode === 'merge' ? 'слияние' : 'передача';
      parts.push(this.#transferSource ? `${what}: «${this.#transferSource.label}»` : `режим ${what}`);
    }
    if (this.#stretch.active) {
      const outcome = holeOutcome(this.#stretch.factor, this.#ctx.prefs.get().holeVoid);
      parts.push(`дыра ${Math.round(this.#stretch.factor * 100)}% — ${holeOutcomeLabel(outcome)}`);
    }
    if (inHole) parts.push(`в чёрной дыре: ${inHole}`);
    if (scale !== 100) parts.push(`сцена ${scale}%`);
    const extra = parts.length ? ` · ${parts.join(' · ')}` : '';
    this.#panelMode.textContent = `в 3D: ${this.#graph.nodes.length} узлов · ${this.#graph.links.length} рёбер${extra}`;
  }

  #renderPanel(): void {
    if (this.#panelStats) this.#panelStats.textContent = this.#statusText;
    const body = this.#panelBody;
    if (!body) return;

    if (this.#selected) {
      const node = this.#selected;
      const rows = this.#connections.filter(
        (connection) =>
          (node.kind === 'process' && connection.process === node.process) ||
          (node.kind === 'remote' && connection.remote.ip === node.ip),
      );
      // Подключения узла берём из графа: после ручных передач это не то же самое, что
      // соединения процесса в системе — и панель обязана показывать именно линии сцены.
      const requests = this.#graph.connectionsOf(node);
      const protocols = new Map<string, number>();
      for (const connection of requests) {
        protocols.set(connection.protocol, (protocols.get(connection.protocol) ?? 0) + 1);
      }
      const breakdown = [...protocols.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([protocol, count]) => `${protocol.toUpperCase()} ${count}`)
        .join(' · ');
      const pinned = node.fx !== null && node.fx !== undefined;
      body.innerHTML = `<div class="hud-label">${escapeHtml(node.kind === 'process' ? 'процесс' : node.kind === 'remote' ? 'удалённый хост' : 'машина')}</div>
        <div style="font-size:13px;margin:4px 0 6px">${escapeHtml(node.label)}</div>
        <div class="hud-field-value">подключений в сцене: ${requests.length}${breakdown ? ` · ${escapeHtml(breakdown)}` : ''}</div>
        ${
          (() => {
            const holder = this.#graph.holderOf(node);
            if (holder) {
              return `<div class="hud-label" style="margin-top:6px">подключения переданы орбу «${escapeHtml(holder.label)}» · перетащите орб на этот, чтобы вернуть</div>`;
            }
            const system = this.#requestsOf(node).length;
            if (holder === undefined && system > 0 && requests.length === 0) {
              return `<div class="hud-label" style="margin-top:6px">линий в сцене нет · в системе соединений: ${system}</div>`;
            }
            return '';
          })()
        }
        ${
          this.#pointMode
            ? this.#transferSource
              ? `<div class="hud-label" style="margin-top:6px">режим ${this.#pointMode === 'merge' ? 'слияния' : 'передачи'} · выбран «${escapeHtml(this.#transferSource.label)}» · щёлкните орб того же типа, ${this.#pointMode === 'merge' ? 'в который слить' : 'который примет'}</div>`
              : `<div class="hud-label" style="margin-top:6px">режим ${this.#pointMode === 'merge' ? 'слияния' : 'передачи'} · щёлкните орб, ${this.#pointMode === 'merge' ? 'который растворится' : 'у которого забрать подключения'}</div>`
            : pinned
              ? '<div class="hud-label" style="margin-top:6px">орб в руке/оставлен · «Вернуть узлы» возвращает всё</div>'
              : '<div class="hud-label" style="margin-top:6px">щипок — вырвать; T — передать подключения, Y — слить орбы; свести два орба двумя руками — слияние</div>'
        }
        ${
          node.mergedFrom?.length
            ? `<div class="hud-label" style="margin-top:6px">вобрал в себя: ${escapeHtml(node.mergedFrom.join(', '))}</div>`
            : ''
        }`;
      const list = document.createElement('div');
      list.className = 'hud-group';
      for (const connection of rows.slice(0, 40)) {
        const row = document.createElement('div');
        row.className = 'hud-row';
        row.style.fontSize = '11.5px';
        row.innerHTML = `<span class="hud-mono" style="color:var(--cyan)">${escapeHtml(connection.protocol.toUpperCase())}</span>
          <span class="hud-mono">${escapeHtml(connection.remote.ip || '*')}:${connection.remote.port || ''}</span>
          <span class="hud-label" style="margin-left:auto">${escapeHtml(connection.state)}</span>`;
        list.appendChild(row);
      }
      body.appendChild(list);
      if (rows.length === 0) {
        body.innerHTML += '<div class="hud-label">Соединений больше нет (Esc — снять выделение)</div>';
      }
    } else {
      const top = topProcesses(this.#connections, 8);
      body.innerHTML = `<div class="hud-label">Активные процессы</div>`;
      const list = document.createElement('div');
      list.className = 'hud-group';
      list.style.marginTop = '6px';
      for (const [process, count] of top) {
        const row = document.createElement('div');
        row.className = 'hud-row';
        row.style.fontSize = '11.5px';
        row.innerHTML = `<span>${escapeHtml(process)}</span><span class="hud-mono" style="margin-left:auto;color:var(--cyan)">${count}</span>`;
        list.appendChild(row);
      }
      body.appendChild(list);
      const hands = document.createElement('div');
      hands.className = 'hud-label';
      hands.style.marginTop = '10px';
      hands.textContent =
        'Руки: щипок по орбу — вырвать (его подключения заберёт сосед); рывок кистью при отпускании — ' +
        'бросок в чёрную дыру; щипок по чёрной дыре — она раскроется и отдаст орб; щипок в пустоте — ' +
        'вращение и наклон сцены; свести/развести две руки — сложить всю сцену в ладонь и развернуть; ' +
        'вторая рука щипком — второй орб сразу. Обе руки на дыре: разведите — дыра растянется, и по силе ' +
        'растяжения отпускание либо схлопнёт её с возвратом орбов, либо взорвёт, либо (на максимуме) она ' +
        'поглотит всё и приложение закроется. Свести два орба двумя руками — слить их в один. Одна рука ' +
        'держит орб, вторая щипнула дыру — орб уходит за горизонт без броска. Передать подключения: ' +
        'кнопка «Передать подключения» (или T) — щипните отдающий орб, затем приёмник; слияние — ' +
        'кнопка «Слить орбы» (или Y). Перетаскивание орба на орб тоже работает.';
      body.appendChild(hands);

      const hint = document.createElement('div');
      hint.className = 'hud-label';
      hint.style.marginTop = '6px';
      hint.textContent = this.#hasGeoData
        ? 'Кликните соединение в списке — покажу детали; по узлу на глобусе — что за хост'
        : this.#snapshot?.elevated === false
          ? 'Без прав администратора: соединения видны, объём трафика будет с ETW (этап 3), ' +
            'координаты хостов — с GeoIP (этап 3), поэтому глобус пока пустой'
          : 'Координаты хостов появятся с GeoIP (этап 3, оффлайн-база MaxMind) — до тех пор ' +
            'работает граф';
      body.appendChild(hint);
    }
  }
}

/* ─────────────────────────── Хелперы ─────────────────────────── */

function latLonToVector(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function topProcesses(connections: NetConnection[], limit: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const connection of connections) {
    counts.set(connection.process, (counts.get(connection.process) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
