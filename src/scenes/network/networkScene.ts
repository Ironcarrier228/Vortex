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
import { ForceGraph, type GraphNode } from './graph';
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

  /** Две руки: разведение — зум, поворот кистей — вращение вокруг центра. */
  controlOrbit(zoom: number, twist: number): void {
    this.#orbit.zoomBy(zoom);
    this.#orbit.rotateBy(twist, 0);
  }

  /** Жест «класс»: переключить «граф» ↔ «глобус». */
  onGesture(name: string): boolean {
    if (name !== 'thumbs-up') return false;
    this.#ctx.prefs.set({ networkGlobe: !this.#ctx.prefs.get().networkGlobe });
    return true;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
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
    const anchor = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0);
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
      if (pointer.source !== 'hand') return;
      const node = this.#graph.hitTest(this.camera, this.#ndc.x, this.#ndc.y, GRAB_RADIUS_HAND);
      // Узел не поймали — значит щипок в пустоте: тянем саму сцену (граф вращается за рукой).
      if (!node) {
        this.#holdSpace();
        return;
      }
      this.#hovered = node;
      this.#spaceHold = null;
      this.#beginDrag(node);
      return;
    }

    // Обычный путь: указатель сдвинулся достаточно далеко от точки нажатия.
    if (this.#ndc.distanceTo(this.#dragStartNdc) > DRAG_TRIGGER_NDC) this.#beginDrag(candidate);
  }

  #onPointerRelease(): void {
    this.#releaseDrag();
    this.#dragCandidate = null;
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
    // Рывок кистью (или мыши) = бросок: орб выкинули в чёрную дыру.
    const thrown = node && speed > THROW_SPEED_MIN ? this.#graph.throwNode(node, this.#dragVelocity) : false;
    if (node) this.#graph.setBoost(node, 0);
    this.#graph.endDrag(true, node);
    this.#dragVelocity.set(0, 0, 0);
    this.#hasDragPoint = false;
    this.#ctx.gesture.setGrabbed(false);
    this.#ctx.gesture.setTether(null);
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
   * Щипок в пустоте: держим не узел, а саму сцену. Движение руки вращает и наклоняет граф,
   * поворот кисти доворачивает его вокруг оси взгляда — так сценой можно управлять,
   * не отпуская щипок и не трогая мышь.
   */
  #holdSpace(): void {
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
  #onPointerClick(): void {
    if (this.#dragging) return;
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
    // Что пользователь выкинул руками: проглочено дырой и разорвано связей.
    const eaten = this.#graph.devoured;
    const severed = this.#graph.severedCount;
    const extra = eaten || severed ? ` · проглочено ${eaten} · разорвано связей ${severed}` : '';
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
      const requests = this.#requestsOf(node);
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
        <div class="hud-field-value">запросов: ${requests.length}${breakdown ? ` · ${escapeHtml(breakdown)}` : ''}</div>
        ${
          pinned
            ? '<div class="hud-label" style="margin-top:6px">вырван из цепочки и оставлен · «Вернуть узлы» возвращает всё</div>'
            : '<div class="hud-label" style="margin-top:6px">щипок/зажать — вырвать узел и покрутить кистью; рывок при отпускании — выкинуть в чёрную дыру</div>'
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
        'Руки: щипок по орбу — вырвать; рывок кистью при отпускании — чёрная дыра проглотит орб ' +
        'вместе со связями; щипок в пустоте — вращение и наклон сцены (поворот кисти доворачивает); ' +
        'вторая рука щипком — второй орб; развести руки — масштаб.';
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
