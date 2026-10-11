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
  index?: number;
}

export interface GraphLink {
  id: string;
  source: GraphNode;
  target: GraphNode;
  connection: NetConnection;
  /** 0..1 — насколько «горячее» соединение (для цвета рёбер). */
  heat: number;
  kind: 'local-process' | 'process-remote';
}

export interface Pulse {
  link: GraphLink;
  t: number;
  speed: number;
}

const NODE_GEOMETRY = new THREE.IcosahedronGeometry(1, 2);
const MAX_PULSES = 900;

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
      const processId = `process:${connection.process}`;
      const remoteId = `remote:${connection.remote.ip}:${connection.remote.port}:${connection.protocol}`;

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

      this.#ensureLink(`lp:${processId}`, processNode, this.#localNode, 'local-process', connection);
      const link = this.#ensureLink(
        `pr:${connection.id}`,
        processNode,
        remoteNode,
        'process-remote',
        connection,
      );
      link.heat = Math.min(1, link.heat + 0.5);
      if (connection.state === 'ESTABLISHED') this.#spawnPulse(link);
    }

    // Чистим то, что исчезло из таблицы соединений.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (node.kind === 'local' || seen.has(node.id)) continue;
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

    this.#simulation.nodes(this.nodes);
    // forceLink типизирован как Force<GraphNode, GraphLink>; сужаем безопасно.
    const linkForce = this.#simulation.force('link') as unknown as { links(links: GraphLink[]): void };
    linkForce.links(this.links);
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), 0.55));

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
  ): GraphLink {
    const existing = this.links.find((link) => link.id === id);
    if (existing) {
      existing.connection = connection;
      return existing;
    }
    const link: GraphLink = { id, source, target, connection, heat: 0.4, kind };
    this.links.push(link);
    return link;
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

  /** Шаг физики + обновление геометрии. Вызывается каждый кадр. */
  update(dt: number, time: number, selectedId: string | null): void {
    // Физику гоняем только пока система «горячая» — иначе CPU простаивает.
    if (this.#simulation.alpha() > 0.005) this.#simulation.tick();

    for (const node of this.nodes) {
      // Плавное затухание интенсивности и подъём «пульсации» процесса.
      node.intensity += (node.target - node.intensity) * Math.min(1, dt * 1.6);
      node.target = Math.max(node.target - dt * 0.12, node.kind === 'local' ? 0.35 : 0.12);
      node.degree = node.degree || 1;
    }

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const pulse = 1 + Math.sin(time * (2.4 + node.intensity * 3) + i) * 0.08 * node.intensity;
      const base =
        node.kind === 'local' ? 5.4 : node.kind === 'process' ? 2.1 + Math.min(node.degree, 12) * 0.12 : 1.35;
      const size = base * (0.85 + node.intensity * 0.55) * pulse;
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
      this.#nodeMesh.setColorAt(i, color);
    }
    this.#nodeMesh.count = Math.max(1, this.nodes.length);
    this.#nodeMesh.instanceMatrix.needsUpdate = true;
    if (this.#nodeMesh.instanceColor) this.#nodeMesh.instanceColor.needsUpdate = true;

    // Рёбра: позиции узлов + «остывание».
    let linkIndex = 0;
    for (const link of this.links) {
      link.heat = Math.max(link.heat - dt * 0.35, 0.12);
      const offset = linkIndex * 6;
      this.#linkPositions[offset] = link.source.x ?? 0;
      this.#linkPositions[offset + 1] = link.source.y ?? 0;
      this.#linkPositions[offset + 2] = link.source.z ?? 0;
      this.#linkPositions[offset + 3] = link.target.x ?? 0;
      this.#linkPositions[offset + 4] = link.target.y ?? 0;
      this.#linkPositions[offset + 5] = link.target.z ?? 0;

      const color = this.#tempColor;
      if (link.kind === 'local-process') {
        color.copy(NEON.cyan).multiplyScalar(0.25 + link.heat * 0.75);
      } else {
        heatPalette(link.heat, color).multiplyScalar(0.3 + link.heat * 0.9);
      }
      this.#linkColors[offset] = color.r;
      this.#linkColors[offset + 1] = color.g;
      this.#linkColors[offset + 2] = color.b;
      this.#linkColors[offset + 3] = color.r * 0.55;
      this.#linkColors[offset + 4] = color.g * 0.55;
      this.#linkColors[offset + 5] = color.b * 0.55;
      linkIndex++;
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
    const point = new THREE.Vector3();
    let best: GraphNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of this.nodes) {
      point.set(node.x ?? 0, node.y ?? 0, node.z ?? 0).project(camera);
      if (point.z < -1 || point.z > 1) continue;
      const distance = Math.hypot(point.x - ndcX, point.y - ndcY);
      const tolerance = threshold * (node.kind === 'local' ? 1.9 : node.kind === 'process' ? 1.25 : 0.95);
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

  dispose(): void {
    // NODE_GEOMETRY общая для всех экземпляров — её не освобождаем.
    this.#nodeMaterial.dispose();
    this.#linksGeometry.dispose();
    (this.#linksMesh.material as THREE.Material).dispose();
    this.#pulsesGeometry.dispose();
    (this.#pulsesMesh.material as THREE.Material).dispose();
  }
}
