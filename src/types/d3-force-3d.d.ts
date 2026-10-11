/**
 * Минимальные типы для `d3-force-3d` (у пакета нет собственных .d.ts).
 *
 * Описаны только те силы и методы, которые использует VORTEX: этого достаточно для
 * строгой типизации узлов/рёбер графа, без имитации полного API d3.
 */
declare module 'd3-force-3d' {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<NodeDatum> {
    source: NodeDatum | string | number;
    target: NodeDatum | string | number;
    index?: number;
  }

  /** Любая сила: сама функция шага + фабричные методы возвращают this. */
  export interface Force<Node, Link> {
    (alpha: number): void;
    initialize?(nodes: Node[], random: () => number): void;
  }

  export interface LinkForce<Node, Link> extends Force<Node, Link> {
    links(): Link[];
    links(links: Link[]): this;
    id(accessor: (node: Node, index: number, nodes: Node[]) => string | number): this;
    distance(value: number | ((link: Link, index: number, links: Link[]) => number)): this;
    strength(value: number | ((link: Link, index: number, links: Link[]) => number)): this;
    iterations(value: number): this;
  }

  export interface ManyBodyForce<Node> extends Force<Node, never> {
    strength(value: number | ((node: Node, index: number, nodes: Node[]) => number)): this;
    distanceMin(value: number): this;
    distanceMax(value: number): this;
    theta(value: number): this;
  }

  export interface RadialForce<Node> extends Force<Node, never> {
    radius(value: number | ((node: Node, index: number, nodes: Node[]) => number)): this;
    strength(value: number | ((node: Node, index: number, nodes: Node[]) => number)): this;
  }

  export interface CollideForce<Node> extends Force<Node, never> {
    radius(value: number | ((node: Node, index: number, nodes: Node[]) => number)): this;
    strength(value: number): this;
    iterations(value: number): this;
  }

  export interface Simulation<Node, Link> {
    nodes(): Node[];
    nodes(nodes: Node[]): this;
    /** Тип силы неизвестен: конкретные силы сужаются на стороне вызывающего кода. */
    force(name: string): Force<Node, Link> | undefined;
    force(name: string, force: Force<Node, Link> | null): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaMin(value: number): this;
    alphaDecay(): number;
    alphaDecay(value: number): this;
    alphaTarget(): number;
    alphaTarget(value: number): this;
    velocityDecay(): number;
    velocityDecay(value: number): this;
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
    find(x: number, y: number, z?: number): Node | undefined;
    on(name: string, listener: (this: Simulation<Node, Link>) => void): this;
  }

  export function forceSimulation<Node, Link = undefined>(
    nodes?: Node[],
    numDimensions?: number,
  ): Simulation<Node, Link>;

  export function forceLink<Node, Link = SimulationLinkDatum<Node>>(links?: Link[]): LinkForce<Node, Link>;
  export function forceManyBody<Node>(): ManyBodyForce<Node>;
  export function forceCenter(x?: number, y?: number, z?: number): Force<never, never>;
  export function forceRadial<Node>(radius?: number, x?: number, y?: number, z?: number): RadialForce<Node>;
  export function forceCollide<Node>(
    radius?: number | ((node: Node, index: number, nodes: Node[]) => number),
  ): CollideForce<Node>;
}
