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
  /** Значения, к которым возвращает `reset()` (жест «кулак», кнопка сброса). */
  #homeDistance: number;
  #homePolar = Math.PI * 0.42;
  #homeTarget: THREE.Vector3;
  /** Временно отключить реакцию на мышь (например, пока узел тянет рука или жест). */
  #suspended = false;

  constructor(camera: THREE.PerspectiveCamera, options: OrbitOptions = {}) {
    this.camera = camera;
    this.#target = options.target?.clone() ?? new THREE.Vector3();
    this.#distance = options.distance ?? 9;
    this.#minDistance = options.minDistance ?? 2.5;
    this.#maxDistance = options.maxDistance ?? 40;
    this.#autoRotate = options.autoRotate ?? 0.06;
    this.#minPolar = options.minPolar ?? 0.25;
    this.#maxPolar = options.maxPolar ?? Math.PI - 0.25;
    this.#homeDistance = this.#distance;
    this.#homePolar = this.#polar;
    this.#homeTarget = this.#target.clone();
    this.update(0);
  }

  /** Вернуть камеру в исходное положение (без телепорта: доводим за секунду в `update`). */
  reset(): void {
    this.#target.copy(this.#homeTarget);
    this.#azimuth = 0;
    this.#polar = this.#homePolar;
    this.#distance = this.#homeDistance;
    this.#velocityAzimuth = 0;
    this.#velocityPolar = 0;
    this.#idle = 0;
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

  /** Повернуть камеру программно (жесты двумя руками, кнопки HUD). */
  rotateBy(azimuthDelta: number, polarDelta: number): void {
    this.#azimuth += azimuthDelta;
    this.#polar = THREE.MathUtils.clamp(this.#polar + polarDelta, this.#minPolar, this.#maxPolar);
    this.#idle = 0;
  }

  /** Зум программно: `factor` > 1 приближает (дистанция делится). */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.#distance = THREE.MathUtils.clamp(
      this.#distance / factor,
      this.#minDistance,
      this.#maxDistance,
    );
    this.#idle = 0;
  }

  setAutoRotate(speed: number): void {
    this.#autoRotate = speed;
  }

  /**
   * Приостановить вращение мышью (но оставить программные повороты и зум).
   * Нужно, когда указатель занят перетаскиванием объекта: камера не должна уезжать.
   */
  setSuspended(suspended: boolean): void {
    this.#suspended = suspended;
    if (suspended) {
      this.#dragging = false;
      this.#velocityAzimuth = 0;
      this.#velocityPolar = 0;
    }
  }

  attach(element: HTMLElement): () => void {
    const onPointerDown = (event: PointerEvent) => {
      if (!this.enabled || this.#suspended || event.button !== 0) return;
      this.#dragging = true;
      this.#pointerId = event.pointerId;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (this.#suspended || !this.#dragging) return;
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
