"""
Nyx avatar renderer — black hole + constellation visual
Generates three video loops: standby, thinking, speaking

standby  : slow orbital drift, few dim stars, faint accretion glow
thinking : medium speed, more stars, pulsing core, subtle connection lines
speaking : fast orbit, dense star field, bright core, active constellation web
"""

import math
import os
import random
import struct
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ── config ────────────────────────────────────────────────────────────────────
SIZE        = 1080
FPS         = 30
BG          = (0, 0, 0)
CENTER      = (SIZE // 2, SIZE // 2)
CX, CY      = CENTER

OUT_DIR     = Path("/home/gyoku/nyx-render/frames")
OUT_DIR.mkdir(parents=True, exist_ok=True)

VARIANTS = {
    "standby":  dict(duration=6,  n_stars=55,  orbit_speed=0.18, core_r=95,  core_glow=0.80, line_dist=160, line_alpha=45,  pulse=0.05, accretion=True),
    "thinking": dict(duration=4,  n_stars=75,  orbit_speed=0.55, core_r=105, core_glow=0.92, line_dist=195, line_alpha=65,  pulse=0.14, accretion=True),
    "speaking": dict(duration=3,  n_stars=100, orbit_speed=1.10, core_r=115, core_glow=1.00, line_dist=220, line_alpha=85,  pulse=0.24, accretion=True),
}

# ── star class ────────────────────────────────────────────────────────────────
class Star:
    def __init__(self, cfg, rng):
        # orbital radius — avoid the black hole core
        min_r = cfg["core_r"] + 40
        max_r = SIZE // 2 - 30
        self.orbit_r   = rng.uniform(min_r, max_r)
        self.angle     = rng.uniform(0, 2 * math.pi)
        self.speed     = rng.uniform(0.4, 1.0) * cfg["orbit_speed"] * (1.0 / (self.orbit_r ** 0.45))
        self.size      = rng.uniform(1.0, 3.2)
        self.brightness= rng.uniform(180, 255)
        # slight elliptical distortion toward the center (gravitational lensing feel)
        self.eccen     = rng.uniform(0.88, 1.0)
        self.phase     = rng.uniform(0, 2 * math.pi)

    def pos(self, t):
        a = self.angle + self.speed * t
        x = CX + self.orbit_r * math.cos(a) * self.eccen
        y = CY + self.orbit_r * math.sin(a)
        return x, y

# ── draw helpers ──────────────────────────────────────────────────────────────

def draw_core_glow(draw_layer, r_base, intensity, pulse_amp, t):
    """Layered radial glow for the black hole — dark center, purple/blue rim."""
    pulse = 1.0 + pulse_amp * math.sin(t * 2.5)
    r = r_base * pulse

    steps = 32
    for i in range(steps, 0, -1):
        frac  = i / steps
        # exponential falloff desde el rim hacia afuera
        alpha = int(intensity * 220 * math.exp(-3.5 * (1 - frac)))
        rr = int(70  * frac * intensity)
        gg = int(15  * frac * intensity)
        bb = int(210 * frac * intensity)
        # radio crece hacia afuera desde r_base
        rad = int(r + r * frac * 2.0)
        cx, cy = int(CX), int(CY)
        box = [cx - rad, cy - rad, cx + rad, cy + rad]
        draw_layer.ellipse(box, fill=(rr, gg, bb, alpha))

    # hard dark core (event horizon) — perfectamente centrado
    er = int(r * 0.52)
    cx, cy = int(CX), int(CY)
    draw_layer.ellipse([cx - er, cy - er, cx + er, cy + er], fill=(0, 0, 0, 255))


def draw_accretion_disk(draw_layer, r_base, intensity, t):
    """Thin horizontal band of warm light around the equator."""
    pulse = 1.0 + 0.06 * math.sin(t * 3.1)
    r = r_base * pulse * 1.1
    thickness = max(2, int(r * 0.07))
    alpha = int(intensity * 130)
    for dy in range(-thickness, thickness + 1):
        frac  = abs(dy) / max(thickness, 1)
        a     = int(alpha * (1 - frac) ** 2)
        warm  = int(180 * (1 - frac) * intensity)
        draw_layer.arc(
            [CX - r, CY - r * 0.22, CX + r, CY + r * 0.22],
            start=0, end=360,
            fill=(warm, warm // 4, 0, a),
            width=1,
        )


def draw_star(img_array, x, y, size, brightness):
    """Draw a soft circular star directly into the numpy array."""
    xi, yi = int(round(x)), int(round(y))
    radius = max(1, int(size * 1.5))
    for dx in range(-radius - 2, radius + 3):
        for dy in range(-radius - 2, radius + 3):
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > radius + 1.5:
                continue
            nx, ny = xi + dx, yi + dy
            if not (0 <= nx < SIZE and 0 <= ny < SIZE):
                continue
            falloff = max(0.0, 1.0 - dist / (radius + 0.5)) ** 1.8
            val = int(brightness * falloff)
            # blend into existing pixel
            existing = img_array[ny, nx]
            img_array[ny, nx] = np.clip(existing + np.array([val, val, val + 20], dtype=np.int32), 0, 255).astype(np.uint8)


def draw_lines(draw_layer, positions, max_dist, alpha_max):
    """Connect nearby stars with faint lines — constellation web.
    Solo conecta estrellas que estén a menos de 3/4 del radio total del canvas,
    para evitar polígonos geométricos en los bordes."""
    n = len(positions)
    half = SIZE / 2
    inner_limit = half * 0.68   # solo estrellas dentro de este radio participan
    for i in range(n):
        xi, yi = positions[i]
        di = math.sqrt((xi - CX) ** 2 + (yi - CY) ** 2)
        if di > inner_limit:
            continue
        for j in range(i + 1, n):
            xj, yj = positions[j]
            dj = math.sqrt((xj - CX) ** 2 + (yj - CY) ** 2)
            if dj > inner_limit:
                continue
            dx = xi - xj
            dy = yi - yj
            dist = math.sqrt(dx * dx + dy * dy)
            if dist < max_dist:
                frac  = 1.0 - dist / max_dist
                alpha = int(alpha_max * frac ** 1.6)
                col   = (90, 70, 190, alpha)
                draw_layer.line([(xi, yi), (xj, yj)], fill=col, width=1)


# ── frame renderer ────────────────────────────────────────────────────────────

def render_frame(stars, cfg, t):
    # base image
    img = Image.new("RGB", (SIZE, SIZE), BG)
    arr = np.array(img, dtype=np.uint8)

    # compute star positions this frame
    positions = [s.pos(t) for s in stars]

    # --- draw constellation lines on a separate RGBA layer ---
    line_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    line_draw  = ImageDraw.Draw(line_layer)
    draw_lines(line_draw, positions, cfg["line_dist"], cfg["line_alpha"])

    # merge lines into array
    line_rgb = np.array(line_layer.convert("RGB"))
    line_a   = np.array(line_layer.split()[3], dtype=np.float32) / 255.0
    for c in range(3):
        arr[:, :, c] = np.clip(
            arr[:, :, c].astype(np.float32) + line_rgb[:, :, c] * line_a,
            0, 255
        ).astype(np.uint8)

    # --- draw stars ---
    for i, s in enumerate(stars):
        x, y = positions[i]
        draw_star(arr, x, y, s.size, s.brightness)

    img = Image.fromarray(arr)

    # --- glow layers (RGBA composited on top) ---
    glow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw  = ImageDraw.Draw(glow_layer)

    if cfg["accretion"]:
        draw_accretion_disk(glow_draw, cfg["core_r"], cfg["core_glow"], t)

    draw_core_glow(glow_draw, cfg["core_r"], cfg["core_glow"], cfg["pulse"], t)

    # slight blur on glow for smoothness
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=3))

    img = img.convert("RGBA")
    img = Image.alpha_composite(img, glow_layer)
    img = img.convert("RGB")

    # vignette — darken corners suavemente, sin comer el centro
    vig = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    vd  = ImageDraw.Draw(vig)
    steps = 30
    for i in range(steps):
        frac  = i / steps
        alpha = int(120 * frac ** 2.8)
        r     = int(SIZE // 2 * (1 - frac * 0.38))
        box   = [CX - r, CY - r, CX + r, CY + r]
        vd.ellipse(box, fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), vig).convert("RGB")

    return img


# ── main loop ─────────────────────────────────────────────────────────────────

def render_variant(name, cfg):
    print(f"\n→ Rendering '{name}' ({cfg['duration']}s @ {FPS}fps)...")
    rng     = random.Random(42 + hash(name) % 1000)
    stars   = [Star(cfg, rng) for _ in range(cfg["n_stars"])]
    n_frames = cfg["duration"] * FPS
    var_dir  = OUT_DIR / name
    var_dir.mkdir(exist_ok=True)

    for f in range(n_frames):
        t   = f / FPS
        img = render_frame(stars, cfg, t)
        img.save(var_dir / f"frame_{f:04d}.png")
        if f % FPS == 0:
            print(f"  frame {f}/{n_frames}")

    print(f"  done — {n_frames} frames in {var_dir}")


if __name__ == "__main__":
    for name, cfg in VARIANTS.items():
        render_variant(name, cfg)
    print("\nAll frames rendered. Run ffmpeg to encode.")
