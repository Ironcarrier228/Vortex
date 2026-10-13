/**
 * 3D force-directed граф (d3-force-3d) и его визуализация.
 *
 * Модель:
 *  • узел-«локальный» — сама машина (центр притяжения);
 *  • узел-процесс — программа, создавшая соединения;
 *  • узел-«удалённый хост» — IP/порт, куда идёт трафик.
 *
 * Физику считает d3-force-3d, а геометрию — три InstancedMesh:
 * узлы (икосаэдры), рёбра (LineSegments) и импульсы (Points) для «бегущих» по рёбрам волн.
 */

import * as THREE from 'three';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type Simulation,
} from 'd3-force-3d';

import { NEON, heatPalette } from '../../core/render/materials';
import type { NetConnection } from '../../core/types';
import { BlackHole } from './blackHole';

export type NodeKind = 'local' | 'process' | 'remote';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Детали для тултипа и подписи. */
  pid?: number;
  process?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  host?: string;
  country?: string;
  city?: string;
  lat?: number;
  lon?: number;
  /** Текущая «интенсивность» 0..1 — управляет цветом и размером. */
  intensity: number;
  /** Целевая интенсивность, к которой стремимся (для плавного затухания). */
  target: number;
  degree: number;
  // Поля d3 (заполняются симуляцией на первом шаге)
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Закрепление узла (d3-force): пока задано, узел не двигается физикой. */
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  index?: number;
  /** 0..1 — насколько узел «раздут» для осмотра (растёт, пока его держат). */
  boost?: number;
  /** Куда стремится boost. */
  boostTarget?: number;
  /** Накопленный поворот узла (кистью/мышью при удержании), радианы. */
  spin?: number;
  /** Бросок: пока задано, узел летит сам и заворачивает к чёрной дыре. */
  thrown?: { vx: number; vy: number; vz: number };
  /** Сколько секунд узел в полёте — страховка, чтобы эффект всегда завершался. */
  throwT?: number;
  /** 0..1 — насколько узел уже поглощён (анимация схлопывания в точку). */
  devour?: number;
}

export interface GraphLink {
  id: string;
  source: GraphNode;
  target: GraphNode;
  connection: NetConnection;
  /** 0..1 — насколько «горячее» соединение (для цвета рёбер). */
  heat: number;
  kind: 'local-process' | 'process-remote';

  /* ── Резинка: поведение соединения, когда его узел вырвали из цепочки ── */
  /** Узел, за которым тянется это соединение (пока его держат рукой/мышью). */
  orb?: GraphNode;
  /** Точка крепления к узлу: отстаёт от него — линия видимо «вялая». */
  rab?: { x: number; y: number; z: number };
  /** Сколько секунд соединение тянется за вырванным узлом. */
  rabT?: number;
  /** 0..1 — соединение затянулось в орб: линия схлопнулась и гаснет. */
  absorb?: number;
  /** Итоговая прозрачность линии в этом кадре (для отрисовки и тестов). */
  alpha?: number;

  /* ── Обрыв: узел вырвали (или выкинули) — линия рвётся, а не висит ── */
  /** Точка, в которой линия оторвалась от узла (застывает в воздухе). */
  cut?: { x: number; y: number; z: number };
  /** 0..1 — прогресс обрыва: оторванный конец возвращается к дальнему узлу. */
  cutT?: number;
  /** Какой конец оторвался. */
  cutFrom?: 'source' | 'target';

  /* ── Передача соседу: связи вырванного орба переходят ближайшему орбу ── */
  /** Откуда перелетает конец связи (позиция вырванного узла в момент передачи). */
  flow?: { x: number; y: number; z: number };
  /** 0..1 — прогресс перелёта: конец связи летит от вырванного орба к соседу. */
  flowT?: number;
  /** Какой конец перелетает. */
  flowFrom?: 'source' | 'target';
}

export interface Pulse {
  link: GraphLink;
  t: number;
  speed: number;
}

const NODE_GEOMETRY = new THREE.IcosahedronGeometry(1, 2);

/**
 * Резинка выдёргиваемого узла.
 *
 * Соединение не «приклеено» к узлу намертво: его точка крепления догоняет узел вяло
 * (LINK_LAG_PULL), поэтому при выдёргивании линия заметно отстаёт и тянется. Через
 * LINK_ABSORB_START секунд линия начинает затягиваться в орб и за LINK_ABSORB_TIME
 * схлопывается в него, а на отпускании так же плавно выкатывается обратно.
 */
const LINK_LAG_PULL = 2.2;
const LINK_ABSORB_START = 1.5;
const LINK_ABSORB_TIME = 0.8;
const LINK_RELEASE_RATE = 2.4;
const MAX_PULSES = 900;

/**
 * Чёрная дыра (выкинутый орб).
 *
 * Бросок: узел летит сам, а его скорость каждый кадр доворачивается в сторону дыры —
 * получается затягивание по спирали, которое не может «промахнуться». Через
 * THROW_PATIENCE секунд дыра тянет заметно сильнее: эффект обязан завершиться.
 */
const HOLE_RADIUS: Record<NodeKind, number> = { local: 8, process: 5.4, remote: 4.2 };
const THROW_TURN = 2.6;
const THROW_PATIENCE = 2.4;
/** Сколько узел схлопывается в точку, оказавшись за горизонтом событий (с). */
const DEVOUR_TIME = 0.62;
/** Сколько линия «рвётся»: оторванный конец возвращается к дальнему узлу (с). */
const CUT_TIME = 0.34;
/** Сколько узлов можно держать одновременно (две руки). */
const MAX_GRAB = 2;
/** Сколько летит конец связи, переходящей от вырванного орба к соседу (с). */
const FLOW_TIME = 0.85;
const SHELL_GEOMETRY = new THREE.IcosahedronGeometry(1, 1);
const WHITE = new THREE.Color(1, 1, 1);

export class ForceGraph {
  readonly object = new THREE.Group();
  readonly nodes: GraphNode[] = [];
  readonly links: GraphLink[] = [];
  readonly pulses: Pulse[] = [];

  #simulation: Simulation<GraphNode, GraphLink>;
  #byId = new Map<string, GraphNode>();
  #localNode: GraphNode;
  #nodeMesh: THREE.InstancedMesh;
  #nodeMaterial = new THREE.MeshBasicMaterial({ transparent: true });
  #nodeColors: THREE.Color[] = [];
  #linksGeometry: THREE.BufferGeometry;
  #linksMesh: THREE.LineSegments;
  #linkPositions: Float32Array;
  #linkColors: Float32Array;
  #pulsesGeometry: THREE.BufferGeometry;
  #pulsesMesh: THREE.Points;
  #pulsePositions: Float32Array;
  #selection = new THREE.Color();
  #tempColor = new THREE.Color();
  /** Узлы в руках: двумя руками можно держать два орба одновременно. */
  #grabbed: GraphNode[] = [];
  /** Вращающиеся оболочки вокруг «вырванных» узлов: делают поворот видимым. */
  #shells: THREE.Mesh[] = [];
  /** Чёрная дыра: раскрывается на броске и поглощает выкинутый узел. */
  #hole = new BlackHole();
  /** Идентификаторы узлов, поглощённых чёрной дырой (пока не «Вернуть узлы»). */
  #swallowed = new Set<string>();
  /** Идентификаторы разорванных связей: синхронизация их больше не создаёт. */
  #severed = new Set<string>();
  /**
   * Подстановка узлов: связи вырванного орба переходят соседу. `было → стало`,
   * поэтому синхронизация собирает граф уже с новым владельцем связей, а сам
   * вырванный орб остаётся в сцене без соединений.
   */
  #substitutes = new Map<string, string>();
  /** Что лежит в чёрной дыре: узел и связи, которые надо вернуть вместе с ним. */
  #dumps = new Map<string, { node: GraphNode; connections: NetConnection[] }>();
  /**
   * Журнал ручных передач подключений: кто у кого забрал связи и какие именно —
   * чтобы кнопка «Обратно» вернула всё ровно как было (и в ту, и в другую сторону).
   */
  #rewireLog: {
    fromId: string;
    toId: string;
    links: string[];
    owners: [string, string | undefined][];
  }[] = [];
  /** Орб, который примет подключения, если отпустить здесь (подсвечивается). */
  #dropTarget: GraphNode | null = null;
  /** Общий масштаб сцены: 1 — обычный, меньше — «сложили всю сцену в ладонь». */
  #scale = 1;
  #anchor = new THREE.Vector3();
  #anchorTarget: THREE.Vector3 | null = null;
  #tempVec = new THREE.Vector3();
  #tempVec2 = new THREE.Vector3();
  /** Кого убрать после анимации поглощения (собирается в кадре, чистится после). */
  #devouring: GraphNode[] = [];
  #cutDone: GraphLink[] = [];
  #devouredCount = 0;
  /** Сцена узнаёт о поглощении: тост, панель, счётчики. */
  onSwallow: ((node: GraphNode, links: number) => void) | null = null;
  /** Сцена узнаёт, что связи вырванного орба перешли соседу. */
  onTakeOver: ((node: GraphNode, foster: GraphNode, links: number) => void) | null = null;

  constructor() {
    this.#localNode = {
      id: 'local',
      kind: 'local',
      label: 'эта машина',
      intensity: 0.4,
      target: 0.4,
      degree: 0,
      x: 0,
      y: 0,
      z: 0,
    };

    // Второй аргумент обязателен: у d3-force-3d по умолчанию 2 измерения, нам нужны 3.
    this.#simulation = forceSimulation<GraphNode, GraphLink>([], 3)
      .force(
        'charge',
        forceManyBody<GraphNode>()
          .strength((node: GraphNode) => (node.kind === 'local' ? -320 : node.kind === 'process' ? -90 : -34))
          .distanceMax(120),
      )
      .force(
        'link',
        forceLink<GraphNode, GraphLink>([])
          .id((node) => node.id)
          .distance((link) => (link.kind === 'local-process' ? 26 : 44))
          .strength(0.32),
      )
      .force('center', forceCenter(0, 0, 0))
      .force('collide', forceCollide<GraphNode>(6).iterations(1))
      .force('radial', forceRadial<GraphNode>(70, 0, 0, 0).strength(0.045))
      .alphaDecay(0.035)
      .velocityDecay(0.42)
      .stop();
    this.#simulation.alpha(0.9);

    // Узлы.
    this.#nodeMesh = new THREE.InstancedMesh(NODE_GEOMETRY, this.#nodeMaterial, 1);
    this.#nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#nodeMesh.frustumCulled = false;
    this.object.add(this.#nodeMesh);

    // Рёбра.
    this.#linkPositions = new Float32Array(6);
    this.#linkColors = new Float32Array(6);
    this.#linksGeometry = new THREE.BufferGeometry();
    this.#linksGeometry.setAttribute('position', new THREE.BufferAttribute(this.#linkPositions, 3));
    this.#linksGeometry.setAttribute('color', new THREE.BufferAttribute(this.#linkColors, 3));
    this.#linksMesh = new THREE.LineSegments(
      this.#linksGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.#linksMesh.frustumCulled = false;
    this.object.add(this.#linksMesh);

    // Оболочки «вырванных» узлов: каркасный икосаэдр, вращается вместе с узлом.
    // Обычная сфера при вращении не видна, а каркас сразу показывает поворот.
    // Их несколько: двумя руками можно держать два орба одновременно.
    for (let i = 0; i < MAX_GRAB; i++) {
      const shell = new THREE.Mesh(
        SHELL_GEOMETRY,
        new THREE.MeshBasicMaterial({
          color: 0xf472b6,
          wireframe: true,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      shell.visible = false;
      shell.frustumCulled = false;
      this.#shells.push(shell);
      this.object.add(shell);
    }

    // Чёрная дыра живёт в том же групповом объекте: она часть сцены сети.
    this.object.add(this.#hole.object);

    // Импульсы.
    this.#pulsePositions = new Float32Array(MAX_PULSES * 3).fill(1e6);
    this.#pulsesGeometry = new THREE.BufferGeometry();
    this.#pulsesGeometry.setAttribute('position', new THREE.BufferAttribute(this.#pulsePositions, 3));
    this.#pulsesMesh = new THREE.Points(
      this.#pulsesGeometry,
      new THREE.PointsMaterial({
        size: 1.1,
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.#pulsesMesh.frustumCulled = false;
    this.object.add(this.#pulsesMesh);
  }

  get simulation(): Simulation<GraphNode, GraphLink> {
    return this.#simulation;
  }

  /** Синхронизировать граф со снимком соединений (вызывается при каждом `net/snapshot`). */
  sync(connections: NetConnection[]): void {
    if (!this.#byId.has('local')) {
      this.#byId.set('local', this.#localNode);
      this.nodes.push(this.#localNode);
    }

    const seen = new Set<string>(['local']);
    for (const connection of connections) {
      const rawProcessId = `process:${connection.process}`;
      const rawRemoteId = `remote:${connection.remote.ip}:${connection.remote.port}:${connection.protocol}`;
      // Связи вырванного орба могли перейти соседу — тогда собираем граф уже с ним.
      const processId = this.#resolve(rawProcessId);
      const remoteId = this.#resolve(rawRemoteId);
      // Узел проглочен чёрной дырой: он вернётся только по «Вернуть узлы».
      if (this.#swallowed.has(processId) || this.#swallowed.has(remoteId)) continue;

      const processNode = this.#ensureNode(processId, () => ({
        id: processId,
        kind: 'process',
        label: connection.process,
        process: connection.process,
        pid: connection.pid,
        intensity: 0.2,
        target: 0.2,
        degree: 0,
      }));
      const remoteNode = this.#ensureNode(remoteId, () => ({
        id: remoteId,
        kind: 'remote',
        label: connection.remote.host ?? connection.remote.ip,
        ip: connection.remote.ip,
        port: connection.remote.port,
        protocol: connection.protocol,
        host: connection.remote.host,
        country: connection.remote.country,
        city: connection.remote.city,
        lat: connection.remote.lat,
        lon: connection.remote.lon,
        intensity: 0.2,
        target: 0.2,
        degree: 0,
      }));

      seen.add(processId);
      seen.add(remoteId);

      // Интенсивность растёт при каждом новом соединении и медленно затухает.
      const boost = connection.state === 'ESTABLISHED' ? 0.55 : 0.3;
      processNode.target = Math.min(1, processNode.target + boost * 0.4);
      remoteNode.target = Math.min(1, remoteNode.target + boost);

      // Связь «машина ↔ процесс» не передаётся соседу: у соседа она уже есть (не плодим дубли).
      if (processId === rawProcessId) {
        this.#ensureLink(`lp:${processId}`, processNode, this.#localNode, 'local-process', connection);
      } else {
        this.#severed.add(`lp:${rawProcessId}`);
      }
      const link = this.#ensureLink(
        `pr:${connection.id}`,
        processNode,
        remoteNode,
        'process-remote',
        connection,
      );
      if (link) {
        link.heat = Math.min(1, link.heat + 0.5);
        if (connection.state === 'ESTABLISHED') this.#spawnPulse(link);
      }
    }

    // Чистим то, что исчезло из таблицы соединений.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (node.kind === 'local' || seen.has(node.id)) continue;
      // Вырванный, но не проглоченный орб остаётся в сцене — его держат рукой,
      // а его подключения живут у соседа до кнопки «Вернуть узлы».
      if (this.#grabbed.includes(node) || this.#substitutes.has(node.id) || node.thrown) continue;
      this.#forgetGrabbed(node);
      this.nodes.splice(i, 1);
      this.#byId.delete(node.id);
    }
    for (let i = this.links.length - 1; i >= 0; i--) {
      const link = this.links[i];
      if (link.kind === 'local-process') {
        if (!seen.has(link.source.id)) this.links.splice(i, 1);
        continue;
      }
      if (!seen.has(link.target.id) || !seen.has(link.source.id)) this.links.splice(i, 1);
    }

    for (const node of this.nodes) {
      node.degree = this.links.filter((link) => link.source === node || link.target === node).length;
    }

    this.#refreshLinks(0.55);

    this.#rebuildInstances();
  }

  #ensureNode(id: string, factory: () => GraphNode): GraphNode {
    const existing = this.#byId.get(id);
    if (existing) return existing;
    const node = factory();
    // Стартовая «сфера рассеивания»: симуляция быстро разложит узлы по местам.
    node.x = (Math.random() - 0.5) * 40;
    node.y = (Math.random() - 0.5) * 40;
    node.z = (Math.random() - 0.5) * 40;
    this.#byId.set(id, node);
    this.nodes.push(node);
    return node;
  }

  #ensureLink(
    id: string,
    source: GraphNode,
    target: GraphNode,
    kind: GraphLink['kind'],
    connection: NetConnection,
  ): GraphLink | null {
    // Связь разорвана (узел вырвали / выкинули): пока не «Вернуть узлы» — не создаём.
    if (this.#severed.has(id)) return null;
    const existing = this.links.find((link) => link.id === id);
    if (existing) {
      existing.connection = connection;
      // Идентификатор связи стабилен, а её концы выводятся из текущей топологии: если
      // связи перешли соседу (или вернулись из дыры), конец должен следовать за ними.
      if (existing.source !== source || existing.target !== target) {
        existing.source = source;
        existing.target = target;
      }
      return existing;
    }
    const link: GraphLink = { id, source, target, connection, heat: 0.4, kind };
    this.links.push(link);
    return link;
  }

  /** Куда на самом деле ведут связи узла: цепочка подстановок «вырван → сосед». */
  #resolve(id: string): string {
    let current = id;
    const seen = new Set<string>([id]);
    for (let hop = 0; hop < 8; hop++) {
      const next = this.#substitutes.get(current);
      // Цикл (A → B → A) — это не ошибка данных, но разворачивать его нельзя.
      if (!next || next === current || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current;
  }

  /**
   * Кто из соседей заберёт связи вырванного орба. Идеальный наследник — сосед,
   * который ходит туда же (тогда подхваченные связи выглядят правдоподобно);
   * дальше — процессы (у них есть свои соединения), затем всё остальное и степень узла.
   */
  #fosterFor(node: GraphNode): GraphNode | null {
    const near = new Set<GraphNode>();
    const ownFar = new Set<string>();
    for (const link of this.links) {
      if (link.source !== node && link.target !== node) continue;
      const other = link.source === node ? link.target : link.source;
      if (other === node || other.devour !== undefined || this.#swallowed.has(other.id) || other.thrown) continue;
      near.add(other);
      ownFar.add(other.id);
    }

    // Соседи по графу плюс орбы того же типа: процессы охотно подхватывают связи процесса,
    // хосты — связи хоста. Для пользователя это «соседний орб», а не абстрактный узел.
    const candidates = new Set<GraphNode>(near);
    for (const other of this.nodes) {
      if (other === node || other.kind !== node.kind || other.kind === 'local') continue;
      if (other.devour !== undefined || other.thrown || this.#swallowed.has(other.id)) continue;
      candidates.add(other);
    }

    let best: GraphNode | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const other of candidates) {
      // Сосед того же типа подхватывает связи естественнее всего: процесс — связи процесса,
      // хост — связи хоста. Прямая связь по графу и «ходит туда же» добавляют уверенности.
      let score = other.kind === node.kind ? 3 : other.kind === 'local' ? 1.5 : 1;
      if (near.has(other)) score += 1.5;
      if (ownFar.size > 0) {
        for (const link of this.links) {
          if (link.source !== other && link.target !== other) continue;
          const far = link.source === other ? link.target : link.source;
          if (ownFar.has(far.id)) {
            score += 2;
            break;
          }
        }
      }
      score += Math.min(1.2, (other.degree || 0) * 0.06);
      // Ближний орб — это и есть сосед: чем ближе, тем охотнее отдаём связи.
      const distance = Math.hypot(
        (other.x ?? 0) - (node.x ?? 0),
        (other.y ?? 0) - (node.y ?? 0),
        (other.z ?? 0) - (node.z ?? 0),
      );
      score -= Math.min(2.5, distance / 80);
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  /**
   * «Сосед забирает подключения»: связи вырванного орба переходят ближайшему соседу.
   * Конец каждой связи с анимацией перелетает от вырванного орба к новому владельцу,
   * а подстановка запоминается — синхронизация соберёт граф уже с соседом.
   */
  #takeOver(node: GraphNode): void {
    if (this.#substitutes.has(node.id) || this.#swallowed.has(node.id)) return;
    const foster = this.#fosterFor(node);
    let moved = 0;
    for (const link of [...this.links]) {
      if (link.source !== node && link.target !== node) continue;
      if (link.kind === 'local-process') {
        // Связь «машина ↔ процесс» переходит в связь соседа (она у него уже есть).
        this.#severLink(link, node, false);
        continue;
      }
      const far = link.source === node ? link.target : link.source;
      if (!foster || far === foster) {
        // Наследника нет (или им оказался сам собеседник) — тогда линия рвётся с вспышкой.
        this.#severLink(link, node, true);
        continue;
      }
      this.#transfer(link, node, foster);
      moved++;
    }
    if (foster && moved > 0) {
      this.#substitutes.set(node.id, foster.id);
      this.#refreshLinks();
      this.onTakeOver?.(node, foster, moved);
    }
  }

  /** Перелёт одного конца связи к соседу (визуально: линия «перепрыгивает» на соседний орб). */
  #transfer(link: GraphLink, from: GraphNode, to: GraphNode): void {
    if (link.cutT !== undefined) return;
    if (link.source !== from && link.target !== from) return;
    const side: 'source' | 'target' = link.source === from ? 'source' : 'target';
    link.flow = { x: from.x ?? 0, y: from.y ?? 0, z: from.z ?? 0 };
    link.flowT = 0;
    link.flowFrom = side;
    link.absorb = 0;
    link.rab = undefined;
    link.orb = undefined;
    link.rabT = undefined;
    if (side === 'source') link.source = to;
    else link.target = to;
  }

  /** Пересобрать силы физики: рвущиеся и поглощённые связи в них не участвуют. */
  #refreshLinks(alpha = 0.35): void {
    this.#simulation.nodes(this.nodes);
    // forceLink типизирован как Force<GraphNode, GraphLink>; сужаем безопасно.
    const linkForce = this.#simulation.force('link') as unknown as { links(links: GraphLink[]): void };
    linkForce.links(this.links.filter((link) => link.cutT === undefined));
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), alpha));
  }

  /** Убрать узел из списка «в руках» (например, силу отобрали или его проглотили). */
  #forgetGrabbed(node: GraphNode): void {
    const index = this.#grabbed.indexOf(node);
    if (index >= 0) this.#grabbed.splice(index, 1);
  }

  #spawnPulse(link: GraphLink): void {
    if (this.pulses.length >= MAX_PULSES) this.pulses.shift();
    this.pulses.push({ link, t: Math.random() * 0.1, speed: 0.8 + Math.random() * 0.9 });
  }

  /** Пересоздать буферы под текущее число узлов/рёбер. */
  #rebuildInstances(): void {
    if (this.#nodeMesh.count !== this.nodes.length) {
      const mesh = new THREE.InstancedMesh(NODE_GEOMETRY, this.#nodeMaterial, Math.max(1, this.nodes.length));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.object.remove(this.#nodeMesh);
      this.#nodeMesh = mesh;
      this.object.add(mesh);
      this.#nodeColors = [];
    }

    const linkCount = Math.max(1, this.links.length);
    if (this.#linkPositions.length !== linkCount * 6) {
      this.#linkPositions = new Float32Array(linkCount * 6);
      this.#linkColors = new Float32Array(linkCount * 6);
      this.#linksGeometry.setAttribute('position', new THREE.BufferAttribute(this.#linkPositions, 3));
      this.#linksGeometry.setAttribute('color', new THREE.BufferAttribute(this.#linkColors, 3));
    }
  }

  /**
   * Поведение соединения при выдёргивании его узла:
   *  • пока узел держат — точка крепления вяло догоняет его (линия отстаёт и тянется);
   *  • через LINK_ABSORB_START секунд линия затягивается в орб (absorb → 1);
   *  • после отпускания — плавно выкатывается обратно к своему узлу.
   */
  #updateRubberBand(link: GraphLink, dt: number): void {
    const held = this.#grabbed.find((node) => link.source === node || link.target === node) ?? null;

    if (held) {
      const nodeX = held.x ?? 0;
      const nodeY = held.y ?? 0;
      const nodeZ = held.z ?? 0;
      if (link.orb !== held || !link.rab) {
        // Только что вырвали: точка крепления стартует из узла и остаётся за ним.
        link.orb = held;
        link.rab = { x: nodeX, y: nodeY, z: nodeZ };
        link.rabT = 0;
      }
      link.rabT = (link.rabT ?? 0) + dt;
      const pull = Math.min(1, dt * LINK_LAG_PULL);
      link.rab.x += (nodeX - link.rab.x) * pull;
      link.rab.y += (nodeY - link.rab.y) * pull;
      link.rab.z += (nodeZ - link.rab.z) * pull;

      link.absorb =
        link.rabT > LINK_ABSORB_START
          ? Math.min(1, (link.rabT - LINK_ABSORB_START) / LINK_ABSORB_TIME)
          : 0;
      // Линия всосалась в орб целиком — узел вырван из цепочки по-настоящему:
      // его подключения забирает сосед (или, если соседей нет, линия рвётся с вспышкой).
      if (link.absorb >= 1) {
        this.#takeOver(held);
        if (link.orb === held) this.#severLink(link, held, false);
      }
      return;
    }

    // Узел отпустили: то, что успело затянуться, выкатывается обратно из орба.
    if ((link.absorb ?? 0) > 0) {
      link.absorb = Math.max(0, (link.absorb ?? 0) - dt * LINK_RELEASE_RATE);
      if (link.absorb === 0) {
        link.orb = undefined;
        link.rab = undefined;
        link.rabT = undefined;
      }
      return;
    }

    if (link.orb) {
      link.orb = undefined;
      link.rab = undefined;
      link.rabT = undefined;
    }
  }

  /** Шаг физики + обновление геометрии. Вызывается каждый кадр. */
  update(dt: number, time: number, selectedId: string | null, camera?: THREE.Camera): void {
    // Физику гоняем только пока система «горячая» — иначе CPU простаивает.
    // Во время перетаскивания узел тянет пользователь, физика должна отзываться сразу.
    if (this.#simulation.alpha() > 0.005 || this.#grabbed.length > 0) this.#simulation.tick();

    for (const node of this.nodes) {
      // Плавное затухание интенсивности и подъём «пульсации» процесса.
      node.intensity += (node.target - node.intensity) * Math.min(1, dt * 1.6);
      node.target = Math.max(node.target - dt * 0.12, node.kind === 'local' ? 0.35 : 0.12);
      node.degree = node.degree || 1;
      // Раздувание для осмотра: быстро растёт, мягко возвращается.
      const boostTarget = node.boostTarget ?? 0;
      const boost = node.boost ?? 0;
      node.boost = boost + (boostTarget - boost) * Math.min(1, dt * (boostTarget > boost ? 7 : 4));
      // Выкинутый орб: летит сам и заворачивает к чёрной дыре.
      if (node.thrown) this.#flyToHole(node, dt);
      // Поглощение: узел сжимается в точку за горизонтом событий.
      if (node.devour !== undefined) this.#devourStep(node, dt);
    }
    // Список нельзя менять внутри обхода — убираем проглоченных после него.
    if (this.#devouring.length > 0) this.#forgetDevoured();

    // Масштаб всей сцены: «сложить всё в ладонь». Якорь тянется плавно, чтобы
    // свёрнутая сцена не прыгала, а подъезжала к руке.
    if (this.#anchorTarget) this.#anchor.lerp(this.#anchorTarget, Math.min(1, dt * 3.6));
    this.object.position.copy(this.#anchor);
    this.object.scale.setScalar(this.#scale);

    this.#hole.update(dt, time);
    if (camera) this.#hole.faceCamera(camera);

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const pulse = 1 + Math.sin(time * (2.4 + node.intensity * 3) + i) * 0.08 * node.intensity;
      const base =
        node.kind === 'local' ? 5.4 : node.kind === 'process' ? 2.1 + Math.min(node.degree, 12) * 0.12 : 1.35;
      const hint = node === this.#dropTarget ? 0.5 : 0;
      const inspect = 1 + ((node.boost ?? 0) + hint) * (node.kind === 'remote' ? 2.6 : 1.9);
      const eaten = 1 - Math.min(1, node.devour ?? 0);
      const size = base * (0.85 + node.intensity * 0.55) * pulse * inspect * eaten;
      scale.setScalar(size);
      matrix.makeScale(scale.x, scale.y, scale.z);
      matrix.setPosition(node.x ?? 0, node.y ?? 0, node.z ?? 0);
      this.#nodeMesh.setMatrixAt(i, matrix);

      // Цвет: процессы — неон, удалённые — по «температуре» интенсивности.
      const color = this.#nodeColors[i] ?? (this.#nodeColors[i] = new THREE.Color());
      if (node.kind === 'local') {
        color.copy(NEON.cyan);
      } else if (node.kind === 'process') {
        color.copy(NEON.violet).lerp(NEON.pink, node.intensity * 0.6);
      } else {
        heatPalette(node.intensity, color);
      }
      if (selectedId && node.id === selectedId) {
        color.lerp(this.#selection.setRGB(1, 1, 1), 0.6);
      } else {
        color.multiplyScalar(0.65 + node.intensity * 0.6);
      }
      // Приёмник подключений подсвечиваем белым: сразу видно, куда они перейдут.
      if (node === this.#dropTarget) color.lerp(WHITE, 0.45);
      // Поглощаемый узел гаснет вместе с размером.
      if (eaten < 1) color.multiplyScalar(0.3 + eaten * 0.7);
      this.#nodeMesh.setColorAt(i, color);
    }
    this.#nodeMesh.count = Math.max(1, this.nodes.length);

    // Оболочки «взятых» узлов: следуют за ними и вращаются вместе с поворотом кисти.
    for (let i = 0; i < this.#shells.length; i++) {
      const shell = this.#shells[i];
      const inspected = this.#grabbed[i];
      if (!inspected) {
        shell.visible = false;
        continue;
      }
      shell.visible = true;
      shell.position.set(inspected.x ?? 0, inspected.y ?? 0, inspected.z ?? 0);
      const shellScale =
        (inspected.kind === 'local' ? 5.4 : inspected.kind === 'process' ? 2.6 : 1.6) *
        (1 + (inspected.boost ?? 0) * 2.2) *
        (1 - Math.min(1, inspected.devour ?? 0));
      shell.scale.setScalar(Math.max(0.001, shellScale));
      shell.rotation.set((inspected.spin ?? 0) * 0.35, inspected.spin ?? 0, 0);
    }
    this.#nodeMesh.instanceMatrix.needsUpdate = true;
    if (this.#nodeMesh.instanceColor) this.#nodeMesh.instanceColor.needsUpdate = true;

    // Рёбра: позиции узлов, «остывание», резинка выдёргиваемого узла и обрыв связи.
    let linkIndex = 0;
    this.#cutDone.length = 0;
    for (const link of this.links) {
      link.heat = Math.max(link.heat - dt * 0.35, 0.12);
      const offset = linkIndex * 6;

      let ax = link.source.x ?? 0;
      let ay = link.source.y ?? 0;
      let az = link.source.z ?? 0;
      let bx = link.target.x ?? 0;
      let by = link.target.y ?? 0;
      let bz = link.target.z ?? 0;

      let flash = 0;
      if (link.cutT !== undefined) {
        // Разрыв: оторванный конец «отщёлкивает» к дальнему узлу, линия гаснет со вспышкой.
        link.cutT = Math.min(1, link.cutT + dt / CUT_TIME);
        const from = link.cut;
        const side = link.cutFrom;
        if (from && side) {
          const far = side === 'source' ? link.target : link.source;
          const recoil = link.cutT * link.cutT;
          const freeX = from.x + ((far.x ?? 0) - from.x) * recoil;
          const freeY = from.y + ((far.y ?? 0) - from.y) * recoil;
          const freeZ = from.z + ((far.z ?? 0) - from.z) * recoil;
          if (side === 'source') {
            ax = freeX;
            ay = freeY;
            az = freeZ;
          } else {
            bx = freeX;
            by = freeY;
            bz = freeZ;
          }
        }
        flash = Math.max(0, 1 - link.cutT * 2.5);
        if (link.cutT >= 1) this.#cutDone.push(link);
      } else {
      this.#updateRubberBand(link, dt);
      const anchor = link.orb;
      if (anchor) {
        const nodeX = anchor.x ?? 0;
        const nodeY = anchor.y ?? 0;
        const nodeZ = anchor.z ?? 0;
        const absorb = link.absorb ?? 0;
        const attachment = link.rab ?? { x: nodeX, y: nodeY, z: nodeZ };
        // Точка крепления: сначала отстаёт (вялая), потом втягивается в узел.
        const attachX = attachment.x + (nodeX - attachment.x) * absorb;
        const attachY = attachment.y + (nodeY - attachment.y) * absorb;
        const attachZ = attachment.z + (nodeZ - attachment.z) * absorb;

        if (link.source === anchor) {
          ax = attachX;
          ay = attachY;
          az = attachZ;
        } else {
          bx = attachX;
          by = attachY;
          bz = attachZ;
        }

        // «Затягивается в орб»: дальний конец линии тоже уходит в узел, линия схлопывается.
        if (absorb > 0) {
          if (link.source === anchor) {
            bx += (nodeX - bx) * absorb;
            by += (nodeY - by) * absorb;
            bz += (nodeZ - bz) * absorb;
          } else {
            ax += (nodeX - ax) * absorb;
            ay += (nodeY - ay) * absorb;
            az += (nodeZ - az) * absorb;
          }
        }
      }
      }

      // Перелёт связи к соседу: конец плавно уезжает от вырванного орба к новому владельцу.
      if (link.flow && link.flowT !== undefined) {
        link.flowT = Math.min(1, link.flowT + dt / FLOW_TIME);
        const t = link.flowT * link.flowT * (3 - 2 * link.flowT);
        if (link.flowFrom === 'source') {
          ax = link.flow.x + (ax - link.flow.x) * t;
          ay = link.flow.y + (ay - link.flow.y) * t;
          az = link.flow.z + (az - link.flow.z) * t;
        } else {
          bx = link.flow.x + (bx - link.flow.x) * t;
          by = link.flow.y + (by - link.flow.y) * t;
          bz = link.flow.z + (bz - link.flow.z) * t;
        }
        flash = Math.max(flash, 1 - link.flowT);
        if (link.flowT >= 1) {
          link.flow = undefined;
          link.flowT = undefined;
        }
      }

      link.alpha = link.cutT !== undefined ? 1 - link.cutT : 1 - (link.absorb ?? 0);
      this.#linkPositions[offset] = ax;
      this.#linkPositions[offset + 1] = ay;
      this.#linkPositions[offset + 2] = az;
      this.#linkPositions[offset + 3] = bx;
      this.#linkPositions[offset + 4] = by;
      this.#linkPositions[offset + 5] = bz;

      const color = this.#tempColor;
      if (link.kind === 'local-process') {
        color.copy(NEON.cyan).multiplyScalar(0.25 + link.heat * 0.75);
      } else {
        heatPalette(link.heat, color).multiplyScalar(0.3 + link.heat * 0.9);
      }
      // Затягивание в орб гасит линию: она буквально «уходит внутрь» узла.
      color.multiplyScalar(link.alpha);
      // Вспышка на разрыве: в первые мгновения линия белая, будто искрит.
      if (flash > 0) color.lerp(WHITE, flash);
      this.#linkColors[offset] = color.r;
      this.#linkColors[offset + 1] = color.g;
      this.#linkColors[offset + 2] = color.b;
      this.#linkColors[offset + 3] = color.r * 0.55;
      this.#linkColors[offset + 4] = color.g * 0.55;
      this.#linkColors[offset + 5] = color.b * 0.55;
      linkIndex++;
    }
    // Дорвавшиеся линии убираем из графа — связь разорвана окончательно.
    if (this.#cutDone.length > 0) {
      for (const link of this.#cutDone) {
        const index = this.links.indexOf(link);
        if (index >= 0) this.links.splice(index, 1);
        for (let i = this.pulses.length - 1; i >= 0; i--) {
          if (this.pulses[i].link === link) this.pulses.splice(i, 1);
        }
      }
      this.#cutDone.length = 0;
      this.#rebuildInstances();
      this.#refreshLinks();
    }

    this.#linksGeometry.setDrawRange(0, this.links.length * 2);
    (this.#linksGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.#linksGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // Импульсы: точки, бегущие по рёбрам.
    let pulseIndex = 0;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pulse = this.pulses[i];
      pulse.t += dt * pulse.speed;
      if (pulse.t >= 1) {
        this.pulses.splice(i, 1);
        continue;
      }
      if (pulseIndex >= MAX_PULSES) continue;
      const link = pulse.link;
      const t = pulse.t;
      const x = (link.source.x ?? 0) + ((link.target.x ?? 0) - (link.source.x ?? 0)) * t;
      const y = (link.source.y ?? 0) + ((link.target.y ?? 0) - (link.source.y ?? 0)) * t;
      const z = (link.source.z ?? 0) + ((link.target.z ?? 0) - (link.source.z ?? 0)) * t;
      // Дуга: импульс летит «поверх» прямой линии.
      const lift = Math.sin(t * Math.PI) * 2.4;
      const offset = pulseIndex * 3;
      this.#pulsePositions[offset] = x;
      this.#pulsePositions[offset + 1] = y + lift;
      this.#pulsePositions[offset + 2] = z;
      pulseIndex++;
    }
    for (let i = pulseIndex; i < MAX_PULSES; i++) {
      this.#pulsePositions[i * 3 + 1] = 1e6;
    }
    (this.#pulsesGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.#pulsesMesh.count = MAX_PULSES;
  }

  /**
   * Ближайший узел к курсору. Проецируем узлы в NDC и сравниваем с позицией курсора:
   * так наведение работает без аллокаций Raycaster-геометрии и «ловит» крупные узлы охотнее.
   */
  hitTest(camera: THREE.Camera, ndcX: number, ndcY: number, threshold = 0.045): GraphNode | null {
    const point = this.#tempVec2;
    let best: GraphNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of this.nodes) {
      if (node.devour !== undefined || node.thrown) continue;
      point.set(node.x ?? 0, node.y ?? 0, node.z ?? 0).applyMatrix4(this.object.matrixWorld).project(camera);
      if (point.z < -1 || point.z > 1) continue;
      const distance = Math.hypot(point.x - ndcX, point.y - ndcY);
      // Чем сильнее сцена свёрнута, тем крупнее цель: свёрнутое в ладонь тоже берётся рукой.
      const zoomOut = 1 / Math.max(0.25, this.#scale);
      const tolerance =
        threshold * (node.kind === 'local' ? 1.9 : node.kind === 'process' ? 1.25 : 0.95) * Math.min(3, zoomOut);
      if (distance < tolerance && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  getNode(id: string): GraphNode | undefined {
    return this.#byId.get(id);
  }

  /* ─────────────── Перетаскивание узлов (мышь/жест «щипок») ─────────────── */

  /** Последний взятый узел: с ним работают жесты и мышь. */
  get dragged(): GraphNode | null {
    return this.#grabbed[this.#grabbed.length - 1] ?? null;
  }

  /** Все узлы в руках: двумя руками можно держать два орба одновременно. */
  get grabbedNodes(): readonly GraphNode[] {
    return this.#grabbed;
  }

  get grabbedCount(): number {
    return this.#grabbed.length;
  }

  /** Сколько узлов проглотила чёрная дыра (для панели сцены). */
  get devoured(): number {
    return this.#devouredCount;
  }

  /** Сколько связей разорвано и ждёт «Вернуть узлы». */
  get severedCount(): number {
    return this.#severed.size;
  }

  /** Сколько связей перешло соседям после вырывания орбов. */
  get takeoverCount(): number {
    return this.#substitutes.size;
  }

  /** Сколько орбов лежит в чёрной дыре. */
  get dumpCount(): number {
    return this.#dumps.size;
  }

  /** Общий масштаб сцены (1 — обычный вид). */
  get globalScale(): number {
    return this.#scale;
  }

  /** Мировая позиция узла: локальные единицы графа × масштаб сцены + сдвиг. */
  nodeWorld(node: GraphNode, out = new THREE.Vector3()): THREE.Vector3 {
    return out
      .set(node.x ?? 0, node.y ?? 0, node.z ?? 0)
      .multiplyScalar(this.#scale)
      .add(this.#anchor);
  }

  /**
   * Сложить/развернуть всю сцену: масштаб применяется к самому графу, а не к камере.
   * Именно поэтому «сцена в ладони» — это сцена, а не зум: узлы, связи, дыра и импульсы
   * уменьшаются вместе и остаются живыми.
   */
  setGlobalScale(scale: number): void {
    this.#scale = Math.min(2, Math.max(0.04, scale));
  }

  /**
   * Якорь сцены: куда её поставить. Свёрнутая сцена «лежит в ладони» — сцена тянет её
   * к середине между руками; при развороте якорь возвращается в центр мира (`null`).
   */
  setAnchor(point: THREE.Vector3 | null): void {
    this.#anchorTarget = point ? point.clone() : new THREE.Vector3();
  }

  /** Насколько сцена свёрнута (0 — в точку, 1 — обычный вид) — для подсказок в HUD. */
  get collapsed(): boolean {
    return this.#scale < 0.5;
  }

  /**
   * Попал ли указатель по чёрной дыре. Радиус считаем прямо в NDC: проецируем центр
   * и точку на радиус вбок от него — так размер на экране получается честным.
   */
  hitHole(camera: THREE.PerspectiveCamera, ndcX: number, ndcY: number, slack = 0.02): boolean {
    // Видимую дыру можно и взять рукой, и просто бросить в неё орб — поэтому проверяем
    // только то, что она вообще есть в сцене (пустая дыра ничего не отдаст, см. grabHole).
    if (!this.#hole.alive) return false;
    this.object.updateMatrixWorld();
    const centre = new THREE.Vector3()
      .copy(this.#hole.object.position)
      .applyMatrix4(this.object.matrixWorld)
      .project(camera);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const edge = new THREE.Vector3()
      .copy(this.#hole.object.position)
      .applyMatrix4(this.object.matrixWorld)
      .addScaledVector(right, this.#hole.radius * this.#scale)
      .project(camera);
    const radius = Math.hypot(edge.x - centre.x, edge.y - centre.y);
    return Math.hypot(centre.x - ndcX, centre.y - ndcY) < radius + slack;
  }

  /** Взяться за чёрную дыру (щипок/нажатие по ней): она раскрывается и отдаёт орбы. */
  grabHole(): boolean {
    if (!this.#hole.alive || this.#dumps.size === 0) return false;
    this.#hole.hold(true);
    return true;
  }

  /** Отпустить дыру: она снова становится маленькой, но никуда не исчезает. */
  releaseHole(): void {
    this.#hole.hold(false);
  }

  /**
   * Вытащить из дыры один случайный орб. Узел возвращается в сцену со своими связями:
   * подстановка соседу снимается, разорванные связи оживают, и ближайшая синхронизация
   * собирает их заново. Возвращает узел, чтобы сцена взяла его в руку.
   */
  extractOrb(): GraphNode | null {
    if (this.#dumps.size === 0) return null;
    const keys = [...this.#dumps.keys()];
    const key = keys[Math.floor(Math.random() * keys.length)];
    const dump = this.#dumps.get(key);
    if (!dump) return null;
    this.#dumps.delete(key);
    this.#swallowed.delete(dump.node.id);
    this.#substitutes.delete(dump.node.id);
    for (const connection of dump.connections) {
      this.#severed.delete(`pr:${connection.id}`);
      this.#severed.delete(`lp:${dump.node.id}`);
    }

    const node = dump.node;
    node.devour = undefined;
    node.thrown = undefined;
    node.throwT = undefined;
    node.boost = 0;
    node.boostTarget = 0;
    node.spin = 0;
    node.fx = null;
    node.fy = null;
    node.fz = null;
    // Орб появляется из дыры: ставим его ровно в точку дыры (в локальных единицах графа).
    node.x = this.#hole.object.position.x;
    node.y = this.#hole.object.position.y;
    node.z = this.#hole.object.position.z;
    if (!this.nodes.includes(node)) this.nodes.push(node);
    this.#byId.set(node.id, node);
    this.#devouredCount = Math.max(0, this.#devouredCount - 1);
    // Связи, ушедшие соседу, возвращаются к орбу — с тем же перелётом, что и уходили.
    const ids = new Set(dump.connections.map((connection) => connection.id));
    for (const link of this.links) {
      if (link.kind !== 'process-remote' || !ids.has(link.connection.id)) continue;
      const side: 'source' | 'target' = link.target.kind === 'remote' ? 'source' : 'target';
      const owner = side === 'source' ? link.source : link.target;
      if (owner === node) continue;
      link.flow = { x: owner.x ?? 0, y: owner.y ?? 0, z: owner.z ?? 0 };
      link.flowFrom = side;
      link.flowT = 0;
      if (side === 'source') link.source = node;
      else link.target = node;
    }
    this.#hole.pulse(0.8);
    if (this.#dumps.size === 0) this.#hole.close();
    this.#rebuildInstances();
    this.#refreshLinks();
    return node;
  }

  get hole(): BlackHole {
    return this.#hole;
  }

  /**
   * Взять узел: он закрепляется в текущей точке и дальше следует за указателем
   * (`moveDragged`), а физика перестаёт его тянуть. Возвращает сам узел.
   */
  beginDrag(node: GraphNode): GraphNode {
    if (!this.#grabbed.includes(node)) this.#grabbed.push(node);
    node.fx = node.x ?? 0;
    node.fy = node.y ?? 0;
    node.fz = node.z ?? 0;
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.4));
    return node;
  }

  /** Двигать взятый узел в мировую точку (луч курсора × плоскость узла). */
  moveDragged(world: THREE.Vector3, node: GraphNode | null = this.dragged): void {
    if (!node) return;
    // Указатель приходит в мировых координатах, а узел живёт в локальных единицах графа:
    // учитываем и масштаб сцены, и её сдвиг (свёрнутая сцена висит у руки).
    const point = this.#tempVec.copy(world).sub(this.#anchor).divideScalar(this.#scale);
    node.fx = point.x;
    node.fy = point.y;
    node.fz = point.z;
    node.x = point.x;
    node.y = point.y;
    node.z = point.z;
    node.vx = 0;
    node.vy = 0;
    node.vz = 0;
    node.target = 1;
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.24));
  }

  /**
   * Отпустить узел. `pin = true` — узел остаётся закреплённым там, где его оставили
   * (удобно «расставлять» узлы руками), иначе возвращается в физику.
   */
  endDrag(pin: boolean, node: GraphNode | null = this.dragged): void {
    if (!node) return;
    this.#forgetGrabbed(node);
    if (!pin) {
      node.fx = null;
      node.fy = null;
      node.fz = null;
    }
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.45));
  }

  /**
   * Бросок: орб вырвали и выкинули. Он превращается в «снаряд», а впереди по направлению
   * броска раскрывается чёрная дыра: узел затягивает по спирали, он схлопывается в точку,
   * и все его связи рвутся. `false` — узел бросать нельзя (сама машина или уже проглочен).
   */
  throwNode(node: GraphNode, worldVelocity: THREE.Vector3): boolean {
    // Скорость броска тоже переводим в локальные единицы: свёрнутая сцена летит так же резво.
    const velocity = this.#tempVec.copy(worldVelocity).divideScalar(this.#scale);
    if (node.kind === 'local' || node.devour !== undefined || node.thrown) return false;
    this.#forgetGrabbed(node);
    node.fx = node.x ?? 0;
    node.fy = node.y ?? 0;
    node.fz = node.z ?? 0;
    node.thrown = { vx: velocity.x, vy: velocity.y, vz: velocity.z };
    node.throwT = 0;
    // Орб возвращается к обычному размеру: дыра крупнее его, и в этом весь смысл —
    // видно, как уменьшающийся шарик уходит за горизонт событий.
    node.boostTarget = 0;

    const speed = velocity.length();
    const direction = speed > 1e-3 ? velocity.clone().divideScalar(speed) : new THREE.Vector3(0, 0, -1);
    const lead = Math.min(160, Math.max(34, speed * 0.8));
    const at = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0).addScaledVector(direction, lead);
    if (at.length() > 240) at.setLength(240);
    this.#hole.open(at, HOLE_RADIUS[node.kind]);
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.5));
    return true;
  }

  /**
   * Полёт брошенного узла. Скорость каждый кадр доворачивается в сторону дыры, поэтому
   * затягивание выходит по спирали и не может «промахнуться»; если узел почему-то не
   * долетает, дыра тянет сильнее — эффект обязан завершиться.
   */
  #flyToHole(node: GraphNode, dt: number): void {
    const thrown = node.thrown;
    if (!thrown) return;
    node.throwT = (node.throwT ?? 0) + dt;

    const target = this.#hole.position;
    const hx = target.x - (node.x ?? 0);
    const hy = target.y - (node.y ?? 0);
    const hz = target.z - (node.z ?? 0);
    const distance = Math.hypot(hx, hy, hz) || 1;
    const patience = node.throwT > THROW_PATIENCE ? 2.2 : 1;
    const desire = Math.min(190, (26 + distance * 1.6 + node.throwT * 14) * patience);
    const turn = Math.min(1, dt * THROW_TURN * patience);
    thrown.vx += ((hx / distance) * desire - thrown.vx) * turn;
    thrown.vy += ((hy / distance) * desire - thrown.vy) * turn;
    thrown.vz += ((hz / distance) * desire - thrown.vz) * turn;

    node.x = (node.x ?? 0) + thrown.vx * dt;
    node.y = (node.y ?? 0) + thrown.vy * dt;
    node.z = (node.z ?? 0) + thrown.vz * dt;
    node.fx = node.x;
    node.fy = node.y;
    node.fz = node.z;
    node.spin = (node.spin ?? 0) + dt * 7;
    if (distance < this.#hole.radius * 0.85) this.#startDevour(node);
  }

  /** Узел у горизонта событий: связи рвутся, узел схлопывается в точку. */
  #startDevour(node: GraphNode): void {
    if (node.devour !== undefined) return;
    node.devour = 0;
    node.thrown = undefined;
    node.throwT = undefined;
    // Подключения выкинутого орба забирает сосед — цепочка не рушится.
    this.#takeOver(node);
    // Содержимое орба собираем прямо сейчас: через доли секунды линий уже не будет,
    // а вернуть их вместе с орбом нужно (это и есть «вытащить кого-нибудь из дыры»).
    const connections: NetConnection[] = this.#dumps.get(node.id)?.connections ?? [];
    for (const link of [...this.links]) {
      if (link.source !== node && link.target !== node) continue;
      if (!connections.includes(link.connection)) connections.push(link.connection);
      this.#severLink(link, node);
    }
    this.#dumps.set(node.id, { node, connections });
    this.#hole.pulse(1);
  }

  #devourStep(node: GraphNode, dt: number): void {
    node.devour = Math.min(1, (node.devour ?? 0) + dt / DEVOUR_TIME);
    if (node.devour >= 1) this.#devouring.push(node);
  }

  /** Убрать проглоченные узлы: они вернутся только кнопкой «Вернуть узлы». */
  #forgetDevoured(): void {
    const swallowed = this.#devouring.splice(0, this.#devouring.length);
    for (const node of swallowed) {
      this.#swallowed.add(node.id);
      this.#forgetGrabbed(node);
      const index = this.nodes.indexOf(node);
      if (index >= 0) this.nodes.splice(index, 1);
      this.#byId.delete(node.id);
      // Собираем содержимое орба: узел и все его соединения — чтобы вернуть их вместе,
      // если пользователь засунет руку в дыру и вытащит кого-нибудь обратно.
      const connections: NetConnection[] = [];
      let links = 0;
      for (let i = this.links.length - 1; i >= 0; i--) {
        const link = this.links[i];
        if (link.source !== node && link.target !== node) continue;
        connections.push(link.connection);
        this.#severed.add(link.id);
        this.links.splice(i, 1);
        links++;
      }
      // Поглощение уже собрало содержимое раньше (см. #startDevour) — не теряем его.
      const known = this.#dumps.get(node.id)?.connections ?? [];
      for (const connection of connections) if (!known.includes(connection)) known.push(connection);
      this.#dumps.set(node.id, { node, connections: known });
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const pulse = this.pulses[i];
        if (pulse.link.source === node || pulse.link.target === node) this.pulses.splice(i, 1);
      }
      this.#devouredCount++;
      this.onSwallow?.(node, links);
    }
    if (this.#dumps.size > 0) this.#hole.settle();
    for (const node of this.nodes) {
      node.degree = this.links.filter((link) => link.source === node || link.target === node).length;
    }
    this.#rebuildInstances();
    this.#refreshLinks();
    this.#hole.pulse(1);
    if (this.#dumps.size === 0) this.#hole.close();
  }

  /**
   * Разорвать связь: узел `from` «выпускает» линию. Если рвут на глазах (`snap`),
   * точка отрыва застывает в воздухе и оторванный конец с вспышкой возвращается к дальнему
   * узлу. Разорванная связь запоминается — синхронизация её больше не создаёт, пока
   * пользователь не нажмёт «Вернуть узлы».
   */
  #severLink(link: GraphLink, from: GraphNode, snap = true): void {
    this.#severed.add(link.id);
    if (link.cutT !== undefined) return;
    link.absorb = 0;
    link.rab = undefined;
    link.orb = undefined;
    link.rabT = undefined;
    if (snap) {
      link.cut = { x: from.x ?? 0, y: from.y ?? 0, z: from.z ?? 0 };
      link.cutFrom = link.source === from ? 'source' : 'target';
    }
    // Без `snap` (линия уже всосалась в орб) отрывать нечего — показ закончен сразу.
    link.cutT = snap ? 0 : 1;
    this.#refreshLinks();
  }

  /** Повернуть рассматриваемый узел (кистью при удержании). */
  spinBy(node: GraphNode, delta: number): void {
    node.spin = (node.spin ?? 0) + delta;
  }

  /**
   * Раздуть узел для осмотра (пока его держат): узел растёт, вокруг появляется вращающийся
   * каркас. `target = 0` — плавно вернуть к обычному размеру (после отпускания).
   */
  setBoost(node: GraphNode, target: number, spin = node.spin ?? 0): void {
    node.boostTarget = target;
    node.spin = spin;
  }

  /* ─────────────── Передача подключений: орб → орб (руками) ─────────────── */

  /**
   * Может ли `from` передать подключения `to`: орбы одного типа (процесс ↔ процесс,
   * хост ↔ хост), не «эта машина», не поглощённые и не занятые другой рукой.
   */
  canRewire(from: GraphNode | null, to: GraphNode | null): boolean {
    if (!from || !to || from === to) return false;
    if (from.kind !== to.kind || from.kind === 'local') return false;
    if (from.devour !== undefined || to.devour !== undefined) return false;
    return !this.#grabbed.includes(to);
  }

  /** Орб, который примет подключения, если отпустить указатель здесь. */
  get dropTarget(): GraphNode | null {
    return this.#dropTarget;
  }

  /** Подсветить орб-приёмник (или снять подсветку): видно, куда перейдут подключения. */
  setDropTarget(node: GraphNode | null): void {
    if (this.#dropTarget === node) return;
    if (this.#dropTarget && this.#dropTarget.boostTarget !== undefined) {
      this.#dropTarget.boostTarget = this.#dropTarget === this.#grabbed[0] ? 1 : 0;
    }
    this.#dropTarget = node;
  }

  /** Сколько ручных передач подключений сейчас активно (для панели сцены). */
  get rewireCount(): number {
    return this.#rewireLog.length;
  }

  /** Подключения узла по линиям графа: после передач это не то же, что соединения процесса. */
  connectionsOf(node: GraphNode): NetConnection[] {
    const out: NetConnection[] = [];
    for (const link of this.links) {
      if (link.kind !== 'process-remote') continue;
      if (link.source !== node && link.target !== node) continue;
      out.push(link.connection);
    }
    return out;
  }

  /** Кто сейчас держит подключения узла (если он их отдал руками) — для подсказок. */
  holderOf(node: GraphNode): GraphNode | undefined {
    const owner = this.#resolve(node.id);
    if (owner === node.id) return undefined;
    return this.#byId.get(owner);
  }

  /**
   * Отдать подключения одного орба другому: «соединения этого процесса теперь идут в тот».
   *
   * Каждая линия вырванного орба перелетает к соседнему орбу (`#transfer`), а сама подстановка
   * «кто теперь владелец» живёт в `#substitutes`, поэтому очередной снимок сети не вернёт
   * связи обратно. Работает в обе стороны: перетащите A на B — подключения уйдут к B,
   * перетащите B на A — уйдут к A. Связь «машина ↔ процесс» остаётся у процесса: он сам
   * никуда не делся, переехали только его подключения.
   */
  rewire(from: GraphNode, to: GraphNode): { moved: number; connections: NetConnection[] } | null {
    // Меняться подключениями могут орбы одного типа (процесс ↔ процесс, хост ↔ хост)
    // и не «эта машина»: смешивать типы — значит получить бессмысленную сцену.
    if (!this.canRewire(from, to)) return null;
    const movedIds: string[] = [];
    const connections: NetConnection[] = [];
    for (const link of [...this.links]) {
      if (link.source !== from && link.target !== from) continue;
      if (link.kind !== 'process-remote') continue;
      const far = link.source === from ? link.target : link.source;
      // Уже подключён к этому орбу — второй такой же линии не нужно.
      if (far === to) continue;
      this.#transfer(link, from, to);
      movedIds.push(link.id);
      connections.push(link.connection);
    }
    if (movedIds.length === 0) return null;

    // Владельцем меняем не только сам орб, но и всех, чьи подключения на нём висели
    // (например, после передачи соседу): «всё, что на этом орбе, теперь на том».
    const owners: [string, string | undefined][] = [];
    for (const key of new Set<string>([from.id, ...this.#substitutes.keys()])) {
      if (this.#resolve(key) !== from.id) continue;
      owners.push([key, this.#substitutes.get(key)]);
      if (key === to.id) this.#substitutes.delete(key);
      else this.#substitutes.set(key, to.id);
    }
    this.#rewireLog.push({ fromId: from.id, toId: to.id, links: movedIds, owners });
    this.#refreshLinks();
    return { moved: movedIds.length, connections };
  }

  /**
   * «Обратно»: вернуть подключения прежнему орбу — и линии, и подстановку. Работает и для
   * обратного направления: если вы перетащили B на A, отмена вернёт подключения к B.
   */
  undoRewire(): boolean {
    const record = this.#rewireLog.pop();
    if (!record) return false;
    const from = this.#byId.get(record.fromId);
    const to = this.#byId.get(record.toId);
    for (const [key, before] of record.owners) {
      if (before === undefined) this.#substitutes.delete(key);
      else this.#substitutes.set(key, before);
    }

    if (from && to) {
      for (const id of record.links) {
        const link = this.links.find((candidate) => candidate.id === id);
        if (!link) continue;
        if (link.source === to) this.#transfer(link, to, from);
        else if (link.target === to) this.#transfer(link, to, from);
      }
    }
    this.#refreshLinks();
    return true;
  }

  /**
   * Вернуть всё в исходное: снять закрепления, вернуть разорванные связи и оживить
   * проглоченные узлы (кнопка «Вернуть узлы», жест «кулак»). Сцена после этого делает
   * `sync(...)`, и граф собирается заново из живых соединений.
   */
  unpinAll(): void {
    for (const node of this.nodes) {
      node.fx = null;
      node.fy = null;
      node.fz = null;
      node.boostTarget = 0;
      node.spin = 0;
      node.thrown = undefined;
      node.throwT = undefined;
      node.devour = undefined;
    }
    this.#grabbed.length = 0;
    this.#dropTarget = null;
    this.#rewireLog.length = 0;
    this.#devouring.length = 0;
    this.#cutDone.length = 0;
    for (const shell of this.#shells) shell.visible = false;
    this.#swallowed.clear();
    this.#severed.clear();
    this.#substitutes.clear();
    this.#dumps.clear();
    this.#devouredCount = 0;
    for (let i = this.links.length - 1; i >= 0; i--) {
      if (this.links[i].cutT !== undefined) this.links.splice(i, 1);
    }
    this.#hole.close();
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.6));
  }

  dispose(): void {
    // NODE_GEOMETRY и SHELL_GEOMETRY общие для всех экземпляров — их не освобождаем.
    this.#nodeMaterial.dispose();
    this.#linksGeometry.dispose();
    (this.#linksMesh.material as THREE.Material).dispose();
    this.#pulsesGeometry.dispose();
    (this.#pulsesMesh.material as THREE.Material).dispose();
    for (const shell of this.#shells) (shell.material as THREE.Material).dispose();
    this.#hole.dispose();
  }
}
