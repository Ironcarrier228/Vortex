/**
 * Орбитальная камера: вращение мышью, зум колесом, инерция, авто-вращение.
 * Общий контроллер для аудиовизуализатора и карты сети (в сети он дополняется панорамой).
 */

import * as THREE from 'three';

export interface OrbitOptions {
  /** Радиус по умолчанию. */
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Медленное авто-вращение, если пользователь не трогает мышь (рад/с). */
  autoRotate?: number;
  /** Наклон по умолчанию (радианы от горизонта). */
  minPolar?: number;
  maxPolar?: number;
  /** Целевая точка орбиты. */
  target?: THREE.Vector3;
}

export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  enabled = true;

  #target: THREE.Vector3;
  #distance: number;
  #minDistance: number;
  #maxDistance: number;
  #azimuth = 0;
  #polar = Math.PI * 0.42;
  #minPolar: number;
  #maxPolar: number;
  #autoRotate: number;
  #velocityAzimuth = 0;
  #velocityPolar = 0;
  #dragging = false;
  #lastX = 0;
  #lastY = 0;
  #idle = 0;
  #pointerId: number | null = null;

  constructor(camera: THREE.PerspectiveCamera, options: OrbitOptions = {}) {
    this.camera = camera;
    this.#target = options.target?.clone() ?? new THREE.Vector3();
    this.#distance = options.distance ?? 9;
    this.#minDistance = options.minDistance ?? 2.5;
    this.#maxDistance = options.maxDistance ?? 40;
    this.#autoRotate = options.autoRotate ?? 0.06;
    this.#minPolar = options.minPolar ?? 0.25;
    this.#maxPolar = options.maxPolar ?? Math.PI - 0.25;
    this.update(0);
  }

  get target(): THREE.Vector3 {
    return this.#target;
  }

  get distance(): number {
    return this.#distance;
  }

  /** Сменить целевой радиус (например, чтобы «влететь» в сцену). */
  setDistance(distance: number): void {
    this.#distance = THREE.MathUtils.clamp(distance, this.#minDistance, this.#maxDistance);
  }

  setAutoRotate(speed: number): void {
    this.#autoRotate = speed;
  }

  attach(element: HTMLElement): () => void {
    const onPointerDown = (event: PointerEvent) => {
      if (!this.enabled || event.button !== 0) return;
      this.#dragging = true;
      this.#pointerId = event.pointerId;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.#dragging) return;
      const dx = event.clientX - this.#lastX;
      const dy = event.clientY - this.#lastY;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      this.#azimuth -= dx * 0.0052;
      this.#polar = THREE.MathUtils.clamp(this.#polar - dy * 0.0045, this.#minPolar, this.#maxPolar);
      this.#velocityAzimuth = -dx * 0.0025;
      this.#velocityPolar = -dy * 0.002;
      this.#idle = 0;
    };

    const onPointerUp = (event: PointerEvent) => {
      if (this.#pointerId !== null && element.hasPointerCapture(this.#pointerId)) {
        element.releasePointerCapture(this.#pointerId);
      }
      this.#dragging = false;
      this.#pointerId = null;
      void event;
    };

    const onWheel = (event: WheelEvent) => {
      if (!this.enabled) return;
      event.preventDefault();
      const scale = Math.exp(event.deltaY * 0.0011);
      this.#distance = THREE.MathUtils.clamp(this.#distance * scale, this.#minDistance, this.#maxDistance);
      this.#idle = 0;
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
    };
  }

  update(dt: number): void {
    // Инерция после отпускания мыши.
    if (!this.#dragging) {
      this.#azimuth += this.#velocityAzimuth;
      this.#polar = THREE.MathUtils.clamp(this.#polar + this.#velocityPolar, this.#minPolar, this.#maxPolar);
      this.#velocityAzimuth *= Math.pow(0.02, dt);
      this.#velocityPolar *= Math.pow(0.02, dt);
      this.#idle += dt;
    }

    if (this.#idle > 2.5 && this.#autoRotate !== 0) {
      // Авто-вращение плавно «догоняет» нужную скорость.
      this.#azimuth += this.#autoRotate * dt;
    }

    const sinPolar = Math.sin(this.#polar);
    const x = this.#target.x + this.#distance * sinPolar * Math.sin(this.#azimuth);
    const y = this.#target.y + this.#distance * Math.cos(this.#polar);
    const z = this.#target.z + this.#distance * sinPolar * Math.cos(this.#azimuth);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.#target);
  }
}
