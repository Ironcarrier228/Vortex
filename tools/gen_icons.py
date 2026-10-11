#!/usr/bin/env python3
"""Генератор иконок VORTEX без внешних зависимостей (только stdlib).

Рисует знак-«вихрь»: радиальный градиент + закрученные дуги, затем сохраняет
PNG нужных размеров и однокадровый ICO (PNG-запись внутри контейнера — формат
ICO это допускает с Windows Vista).

Запуск:  python3 tools/gen_icons.py
Результат: src-tauri/icons/{32x32.png,128x128.png,256x256.png,icon.ico}
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

BG_TOP = (6, 12, 26)
BG_BOTTOM = (2, 4, 10)
NEON_A = (34, 211, 238)   # циан
NEON_B = (167, 139, 250)  # фиолет
NEON_C = (244, 114, 182)  # розовый

SS = 4  # супер-сэмплинг для сглаживания


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def swirl_color(angle: float, radius: float) -> tuple[int, int, int]:
    """Цвет дуги: по углу переливается циан → фиолет → розовый."""
    t = (math.sin(angle * 2.0) + 1.0) * 0.5
    base = mix(NEON_A, NEON_B, t)
    return mix(base, NEON_C, max(0.0, radius - 0.55) * 1.1)


def render(size: int) -> list[list[tuple[int, int, int]]]:
    """Отрисовать изображение size×size (супер-сэмплинг, затем усреднение)."""
    big = size * SS
    pixels: list[list[tuple[int, int, int]]] = [
        [(0, 0, 0)] * size for _ in range(size)
    ]
    cx = cy = big / 2.0
    max_r = big * 0.5

    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    px = x * SS + sx + 0.5
                    py = y * SS + sy + 0.5
                    dx = (px - cx) / max_r
                    dy = (py - cy) / max_r
                    r = math.hypot(dx, dy)
                    if r > 1.02:
                        color = (0, 0, 0)
                    else:
                        # Фон: вертикальный градиент + мягкое свечение к центру.
                        base = mix(BG_TOP, BG_BOTTOM, min(1.0, max(0.0, py / big)))
                        glow = max(0.0, 1.0 - r * 1.15) ** 2 * 0.45
                        color = mix(base, (40, 90, 160), glow)

                        # Три закрученные дуги (спираль вихря).
                        angle = math.atan2(dy, dx)
                        for k in range(3):
                            phase = k * (2.0 * math.pi / 3.0)
                            spiral = r * 6.2 + phase  # угол закрутки
                            d = abs(((angle - spiral + math.pi) % (2.0 * math.pi)) - math.pi)
                            band = 1.0 - min(1.0, d / 0.42)
                            if band > 0.0 and 0.16 < r < 0.92:
                                strength = band ** 1.6 * (0.25 + r)
                                color = mix(color, swirl_color(angle, r), min(1.0, strength))
                        # Яркое ядро.
                        if r < 0.14:
                            color = mix(color, (235, 250, 255), (1.0 - r / 0.14) ** 1.2)
                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]
            n = float(SS * SS)
            pixels[y][x] = (
                int(acc[0] / n),
                int(acc[1] / n),
                int(acc[2] / n),
            )
    return pixels


def png_bytes(pixels: list[list[tuple[int, int, int]]]) -> bytes:
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # фильтр None
        for (r, g, b) in row:
            raw += bytes((r, g, b))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8 бит, truecolor RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def ico_bytes(png_256: bytes, size: int = 256) -> bytes:
    """ICO с единственной PNG-записью 256×256 (поддерживается Windows Vista+)."""
    header = struct.pack("<HHH", 0, 1, 1)
    # Ширина/высота 0 = 256 в формате ICO.
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_256), 6 + 16)
    return header + entry + png_256


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cache: dict[int, bytes] = {}
    for size in (32, 128, 256):
        data = png_bytes(render(size))
        cache[size] = data
        path = OUT_DIR / f"{size}x{size}.png"
        path.write_bytes(data)
        print(f"✓ {path.relative_to(OUT_DIR.parent.parent)} ({len(data)} байт)")

    ico_path = OUT_DIR / "icon.ico"
    ico_path.write_bytes(ico_bytes(cache[256]))
    print(f"✓ {ico_path.relative_to(OUT_DIR.parent.parent)}")


if __name__ == "__main__":
    main()
