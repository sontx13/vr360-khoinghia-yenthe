"""
Dựng ảnh 360° MẪU (equirectangular 2:1) cho các điểm di tích chưa có ảnh chụp thực tế.

Ảnh được vẽ bằng ray tracing đơn giản: bầu trời, dãy núi xa, mặt đất, cây và công trình
dựng theo loại di tích (đình/đền, chùa, đồn, hang động, ao, nghĩa địa, khu lưu niệm).
Mỗi ảnh có biển "ẢNH 360° MẪU – MINH HỌA" để không bị nhầm với ảnh thực địa.

Cách dùng (chạy ở thư mục gốc dự án):
    python tools/make_sample_panos.py                 # tạo ảnh cho mọi điểm còn thiếu
    python tools/make_sample_panos.py dinh-dong       # chỉ một điểm
    python tools/make_sample_panos.py --width 2048    # ảnh nhỏ để thử nhanh
Ảnh ghi vào panos/<id>/toan-canh.jpg và toan-canh-thumb.jpg. Không ghi đè ảnh đã có
(thêm --force để ghi đè ảnh mẫu cũ).
"""
import argparse
import json
import math
import os
import sys
import time
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

F = np.float32
CAM_H = 1.6
SUN = np.array([-0.45, 0.72, -0.53], F)
SUN /= np.linalg.norm(SUN)

# Which kind of scene each site gets.
SCENE_TYPE = {
    "don-ho-chuoi": "don", "don-hom": "don", "dong-thien-thai": "cave",
    "ao-chan-ky": "pond", "nghia-dia-phap-doi-phu": "cemetery",
    "khu-luu-niem-hoang-hoa-tham": "memorial", "khu-luu-niem-6-dieu-bac-ho": "memorial",
    "cum-di-tich-cau-vong": "memorial",
}
CATEGORY_TYPE = {"den": "den", "chua": "chua", "don": "don", "khac": "memorial"}

# ---------------------------------------------------------------- noise

_G = np.random.RandomState(7).rand(256, 256).astype(F)


def vnoise(x, y):
    xi = np.floor(x)
    yi = np.floor(y)
    xf = (x - xi).astype(F)
    yf = (y - yi).astype(F)
    xi = xi.astype(np.int64) & 255
    yi = yi.astype(np.int64) & 255
    x1 = (xi + 1) & 255
    y1 = (yi + 1) & 255
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    a, b, c, d = _G[xi, yi], _G[x1, yi], _G[xi, y1], _G[x1, y1]
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def fbm(x, y, octaves=4):
    s = np.zeros_like(x, dtype=F)
    amp, f, tot = 0.5, 1.0, 0.0
    for i in range(octaves):
        s += amp * vnoise(x * f + i * 17.3, y * f - i * 9.1)
        tot += amp
        amp *= 0.5
        f *= 2.0
    return s / tot


def hash2(ix, iy):
    return _G[ix.astype(np.int64) & 255, (iy.astype(np.int64) * 7 + 3) & 255]


def mix(a, b, t):
    t = np.asarray(t, F)[..., None] if np.ndim(t) else t
    return a * (1 - t) + b * t


def col(*rgb):
    return np.array(rgb, F)


def solid(c, n):
    return np.broadcast_to(c, (n, 3)).astype(F)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- materials
# Each material: f(u, v, P) -> rgb (N,3). u, v are surface coordinates in metres.

def m_plaster(base, stain=0.12):
    base = col(*base)

    def f(u, v, P):
        n = fbm(u * 1.3, v * 1.3)
        c = base[None] * (0.9 + 0.16 * n)[:, None]
        dirt = smooth(0.9, 0.0, v) * stain * (0.5 + n)
        return c * (1 - dirt)[:, None]
    return f


def m_stone_blocks(base=(0.52, 0.49, 0.44), bw=0.62, bh=0.34, moss=0.35):
    base = col(*base)

    def f(u, v, P):
        row = np.floor(v / bh)
        uu = u + (row % 2) * bw * 0.5
        cx = np.floor(uu / bw)
        fu = uu / bw - cx
        fv = v / bh - row
        h = hash2(cx, row)
        c = base[None] * (0.72 + 0.45 * h)[:, None]
        c = c * (0.85 + 0.25 * fbm(u * 4, v * 4))[:, None]
        mortar = (np.minimum(np.minimum(fu, 1 - fu) * bw, np.minimum(fv, 1 - fv) * bh) < 0.03)
        c[mortar] *= 0.45
        m = smooth(0.55, 0.8, fbm(u * 0.8 + 3, v * 1.5)) * moss
        return mix(c, col(0.26, 0.36, 0.16)[None], m)
    return f


def m_rock(base=(0.58, 0.57, 0.53)):
    base = col(*base)

    def f(u, v, P):
        n = fbm(u * 0.35, v * 0.35, 5)
        c = base[None] * (0.55 + 0.7 * n)[:, None]
        streak = smooth(0.62, 0.75, fbm(u * 2.5, v * 0.15))
        c = c * (1 - 0.35 * streak)[:, None]
        veg = smooth(0.58, 0.72, fbm(u * 0.5 + 11, v * 0.5 - 4)) * 0.85
        return mix(c, col(0.2, 0.33, 0.12)[None] * (0.7 + 0.6 * n)[:, None], veg)
    return f


def m_roof(base=(0.50, 0.22, 0.14)):
    base = col(*base)

    def f(u, v, P):
        ridge = 0.5 + 0.5 * np.sin(u * (2 * np.pi / 0.24))
        course = (v / 0.28) % 1.0
        c = base[None] * (0.7 + 0.25 * ridge + 0.1 * course)[:, None]
        age = fbm(u * 0.6, v * 0.6)
        c = mix(c, col(0.22, 0.2, 0.17)[None], smooth(0.45, 0.85, age) * 0.6)
        return c
    return f


def m_wood(base=(0.42, 0.12, 0.07)):
    base = col(*base)

    def f(u, v, P):
        g = fbm(u * 8, v * 0.6)
        return base[None] * (0.8 + 0.4 * g)[:, None]
    return f


def m_doors(base=(0.45, 0.16, 0.08), trim=(0.62, 0.45, 0.18), panel=1.1):
    base, trim = col(*base), col(*trim)

    def f(u, v, P):
        fu = (u / panel) % 1.0
        g = fbm(u * 6, v * 0.8)
        c = base[None] * (0.75 + 0.4 * g)[:, None]
        edge = (fu < 0.06) | (fu > 0.94) | (np.abs(v - 1.2) < 0.05) | (np.abs(v - 2.3) < 0.05)
        c[edge] = trim * 0.9
        return c
    return f


def m_leaves(base=(0.2, 0.36, 0.13)):
    base = col(*base)

    def f(u, v, P):
        n = fbm(P[:, 0] * 1.7 + P[:, 1] * 0.7, P[:, 2] * 1.7 - P[:, 1] * 0.9, 4)
        c = base[None] * (0.55 + 0.9 * n)[:, None]
        hi = smooth(0.6, 0.85, n)
        return mix(c, col(0.42, 0.55, 0.2)[None], hi * 0.5)
    return f


def m_trunk(u, v, P):
    g = fbm(u * 6, v * 1.5)
    return col(0.33, 0.24, 0.16)[None] * (0.6 + 0.5 * g)[:, None]


def m_flat(c):
    c = col(*c)

    def f(u, v, P):
        return c[None] * (0.94 + 0.12 * fbm(u * 3, v * 3))[:, None]
    return f


def m_image(img):
    arr = np.asarray(img.convert("RGB"), F) / 255.0
    arr = arr ** 2.2
    h, w = arr.shape[:2]

    def f(u, v, P):  # u, v already normalised 0..1
        x = np.clip((u * (w - 1)).astype(int), 0, w - 1)
        y = np.clip(((1 - v) * (h - 1)).astype(int), 0, h - 1)
        return arr[y, x]
    f.normalized = True
    return f


# ---------------------------------------------------------------- primitives

class Box:
    def __init__(self, lo, hi, mat):
        self.lo, self.hi, self.mat = np.array(lo, F), np.array(hi, F), mat

    def bbox(self):
        return self.lo, self.hi

    def intersect(self, d):
        cam = np.array([0, CAM_H, 0], F)
        inv = 1.0 / np.where(np.abs(d) < 1e-6, 1e-6, d)
        t1 = (self.lo[:, None] - cam[:, None]) * inv
        t2 = (self.hi[:, None] - cam[:, None]) * inv
        tn = np.minimum(t1, t2)
        tf = np.maximum(t1, t2)
        tmin = tn.max(0)
        tmax = tf.min(0)
        hit = (tmax >= tmin) & (tmin > 0)
        return np.where(hit, tmin, np.inf), {"axis": tn.argmax(0)}

    def shade(self, P, aux, d):
        ax = aux["axis"]
        n = np.zeros_like(P)
        idx = np.arange(len(ax))
        n[idx, ax] = -np.sign(d[ax, idx])
        u = np.where(ax == 0, P[:, 2], P[:, 0])
        v = np.where(ax == 1, P[:, 2], P[:, 1] - self.lo[1])
        return self.mat(u, v, P), n


class Cyl:
    def __init__(self, cx, cz, r, y0, y1, mat):
        self.c, self.r, self.y0, self.y1, self.mat = (cx, cz), r, y0, y1, mat

    def bbox(self):
        cx, cz = self.c
        return np.array([cx - self.r, self.y0, cz - self.r], F), np.array([cx + self.r, self.y1, cz + self.r], F)

    def intersect(self, d):
        ox, oz = -self.c[0], -self.c[1]
        a = d[0] ** 2 + d[2] ** 2
        b = 2 * (ox * d[0] + oz * d[2])
        c = ox * ox + oz * oz - self.r ** 2
        disc = b * b - 4 * a * c
        t = (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a + 1e-9)
        y = CAM_H + t * d[1]
        ok = (disc > 0) & (t > 0) & (y >= self.y0) & (y <= self.y1)
        return np.where(ok, t, np.inf), {}

    def shade(self, P, aux, d):
        nx = (P[:, 0] - self.c[0]) / self.r
        nz = (P[:, 2] - self.c[1]) / self.r
        n = np.stack([nx, np.zeros_like(nx), nz], 1)
        u = np.arctan2(nx, nz) * self.r
        return self.mat(u, P[:, 1] - self.y0, P), n


class Sphere:
    def __init__(self, c, r, mat):
        self.cc, self.r, self.mat = np.array(c, F), r, mat

    def bbox(self):
        return self.cc - self.r, self.cc + self.r

    def intersect(self, d):
        o = np.array([0, CAM_H, 0], F) - self.cc
        b = (o[:, None] * d).sum(0)
        c = (o * o).sum() - self.r ** 2
        disc = b * b - c
        t = -b - np.sqrt(np.maximum(disc, 0))
        ok = (disc > 0) & (t > 0)
        return np.where(ok, t, np.inf), {}

    def shade(self, P, aux, d):
        n = (P - self.cc[None]) / self.r
        # bumpy canopy
        bump = fbm(P[:, 0] * 2.1 + P[:, 1], P[:, 2] * 2.1 - P[:, 1], 3) - 0.5
        n = n + 0.5 * bump[:, None]
        n /= np.linalg.norm(n, axis=1, keepdims=True)
        return self.mat(P[:, 0], P[:, 1], P), n


class Quad:
    """Planar quad o + a*u + b*v (u ⟂ v); taper>0 makes a trapezoid / triangle."""

    def __init__(self, o, u, v, mat, taper=0.0):
        self.o, self.u, self.v = np.array(o, F), np.array(u, F), np.array(v, F)
        self.mat, self.taper = mat, taper
        n = np.cross(self.u, self.v)
        self.n = n / np.linalg.norm(n)

    def bbox(self):
        pts = np.array([self.o, self.o + self.u, self.o + self.v, self.o + self.u + self.v])
        return pts.min(0) - 0.01, pts.max(0) + 0.01

    def intersect(self, d):
        cam = np.array([0, CAM_H, 0], F)
        dn = (self.n[:, None] * d).sum(0)
        t = ((self.o - cam) @ self.n) / np.where(np.abs(dn) < 1e-7, 1e-7, dn)
        P = cam[:, None] + t * d
        rel = P - self.o[:, None]
        a = (self.u @ rel) / (self.u @ self.u)
        b = (self.v @ rel) / (self.v @ self.v)
        ok = (t > 0) & (b >= 0) & (b <= 1) & (a >= self.taper * b) & (a <= 1 - self.taper * b)
        return np.where(ok, t, np.inf), {"a": a, "b": b}

    def shade(self, P, aux, d):
        n = np.broadcast_to(self.n, P.shape).copy()
        flip = (n * d.T).sum(1) > 0
        n[flip] *= -1
        if getattr(self.mat, "normalized", False):
            return self.mat(aux["a"], aux["b"], P), n
        return self.mat(aux["a"] * np.linalg.norm(self.u), aux["b"] * np.linalg.norm(self.v), P), n


class RingWall:
    """Wall around the camera (camera inside), with a gap centred on yaw 0."""

    def __init__(self, R, H, gap_deg, mat):
        self.R, self.H, self.gap, self.mat = R, H, math.radians(gap_deg), mat

    def bbox(self):
        return None

    def intersect(self, d):
        hr = np.sqrt(d[0] ** 2 + d[2] ** 2) + 1e-9
        t = self.R / hr
        y = CAM_H + t * d[1]
        th = np.arctan2(d[0], d[2])
        top = self.H + 0.35 * (fbm(th * self.R * 0.8, np.zeros_like(th) + 3.3, 3) - 0.5)
        ok = (y >= 0) & (y <= top) & (np.abs(th) > self.gap)
        return np.where(ok, t, np.inf), {}

    def shade(self, P, aux, d):
        n = np.stack([-P[:, 0], np.zeros(len(P), F), -P[:, 2]], 1) / self.R
        u = np.arctan2(P[:, 0], P[:, 2]) * self.R
        return self.mat(u, P[:, 1], P), n


# ---------------------------------------------------------------- scene helpers

class Scene:
    def __init__(self, seed):
        self.rng = np.random.RandomState(seed)
        self.prims = []
        self.zones = []      # (mask_fn(X,Z), tex_fn(X,Z))
        self.blobs = []      # ground darkening (x, z, r, strength)
        self.rects = []      # (x0, z0, x1, z1) building footprints for occlusion
        self.water = None
        self.hill_amp = 1.0
        self.karst = False

    def add(self, *p):
        self.prims.extend(p)

    def box(self, lo, hi, mat, shadow=True):
        self.add(Box(lo, hi, mat))
        if shadow and hi[1] > 0.4:
            self.rects.append((lo[0], lo[2], hi[0], hi[2], min(1.0, hi[1] / 4)))

    def tree(self, x, z, size=1.0, kind="round"):
        r = self.rng
        trunk_h = (2.2 + r.rand() * 1.5) * size
        self.add(Cyl(x, z, 0.22 * size, 0, trunk_h + 0.6, m_trunk))
        greens = [(0.2, 0.36, 0.13), (0.16, 0.31, 0.12), (0.25, 0.38, 0.15), (0.18, 0.33, 0.17)]
        leaves = m_leaves(greens[r.randint(len(greens))])
        n = 3 if kind == "round" else 4
        for i in range(n):
            ang = r.rand() * 2 * np.pi
            off = (0.0 if i == 0 else 1.1) * size
            rad = (2.0 + r.rand() * 0.9) * size * (1.0 if i == 0 else 0.75)
            cy = trunk_h + rad * 0.55 + (r.rand() * 1.0 if i else 0.4)
            self.add(Sphere((x + off * np.cos(ang), cy, z + off * np.sin(ang)), rad, leaves))
        dx, dz = -SUN[0] / SUN[1] * trunk_h * 0.8, -SUN[2] / SUN[1] * trunk_h * 0.8
        self.blobs.append((x + dx, z + dz, 2.6 * size, 0.45))
        self.blobs.append((x, z, 1.2 * size, 0.3))

    def trees_around(self, count, rmin, rmax, avoid=lambda x, z: False, size=(0.9, 1.4)):
        placed = 0
        tries = 0
        while placed < count and tries < count * 40:
            tries += 1
            ang = self.rng.rand() * 2 * np.pi
            rad = rmin + self.rng.rand() * (rmax - rmin)
            x, z = rad * np.sin(ang), rad * np.cos(ang)
            if avoid(x, z):
                continue
            self.tree(x, z, size[0] + self.rng.rand() * (size[1] - size[0]))
            placed += 1

    def hip_roof(self, x0, x1, z0, z1, ye, rise, mat, ov=1.0, ridge_mat=None):
        """Hip roof over rectangle; z0 = front (towards camera)."""
        L = (x1 - x0) + 2 * ov
        D = (z1 - z0) + 2 * ov
        half = D / 2
        taper_len = min(half, L / 2 - 0.5)
        taper = taper_len / L
        self.add(
            Quad((x0 - ov, ye, z0 - ov), (L, 0, 0), (0, rise, half), mat, taper),
            Quad((x0 - ov, ye, z1 + ov), (L, 0, 0), (0, rise, -half), mat, taper),
            Quad((x0 - ov, ye, z1 + ov), (0, 0, -D), (taper_len, rise, 0), mat, 0.5),
            Quad((x1 + ov, ye, z0 - ov), (0, 0, D), (-taper_len, rise, 0), mat, 0.5),
        )
        rm = ridge_mat or m_plaster((0.45, 0.4, 0.33))
        zc = (z0 + z1) / 2
        rx0, rx1 = x0 - ov + taper_len, x1 + ov - taper_len
        self.add(Box((rx0 - 0.3, ye + rise - 0.05, zc - 0.18), (rx1 + 0.3, ye + rise + 0.32, zc + 0.18), rm))
        # upturned ridge ends ("đầu đao" style)
        for xe, s in ((rx0 - 0.3, -1), (rx1 + 0.3, 1)):
            self.add(Box((min(xe, xe + s * 0.5), ye + rise, zc - 0.15), (max(xe, xe + s * 0.5), ye + rise + 0.75, zc + 0.15), rm))
        # corner eave tips
        for cx_, cz_ in ((x0 - ov, z0 - ov), (x1 + ov, z0 - ov), (x0 - ov, z1 + ov), (x1 + ov, z1 + ov)):
            self.add(Box((cx_ - 0.18, ye - 0.05, cz_ - 0.18), (cx_ + 0.18, ye + 0.55, cz_ + 0.18), rm))

    def hall(self, xc, zf, width, depth, wall_h=3.2, plinth=0.6, tiers=2,
             wall=(0.82, 0.72, 0.5), roof=(0.5, 0.22, 0.14), cols=True):
        """Traditional hall facing the camera; zf = front edge of plinth."""
        x0, x1 = xc - width / 2, xc + width / 2
        z0, z1 = zf, zf + depth
        stone = m_stone_blocks((0.6, 0.57, 0.52), moss=0.1)
        self.box((x0 - 0.6, 0, z0 - 0.6), (x1 + 0.6, plinth, z1 + 0.6), stone)
        # steps
        self.box((xc - 2.0, 0, z0 - 1.4), (xc + 2.0, plinth * 0.5, z0 - 0.6), stone, shadow=False)
        wf = z0 + 1.6  # wall set back behind the veranda
        self.box((x0 + 0.3, plinth, wf), (x1 - 0.3, plinth + wall_h, z1 - 0.3), m_plaster(wall))
        # front doors band on the facade
        self.add(Quad((x0 + 0.3, plinth, wf - 0.02), (width - 0.6, 0, 0), (0, wall_h * 0.8, 0), m_doors()))
        if cols:
            n = max(4, int(width / 2.6)) + 1
            for i in range(n):
                x = x0 + 0.5 + i * (width - 1.0) / (n - 1)
                self.add(Cyl(x, z0 + 0.4, 0.2, plinth, plinth + wall_h + 0.3, m_wood()))
        ye = plinth + wall_h + 0.2
        rm = m_roof(roof)
        if tiers >= 2:
            self.hip_roof(x0, x1, z0, z1, ye, 1.6, rm, ov=1.1)
            # upper storey
            ix0, ix1, iz0, iz1 = x0 + 2.0, x1 - 2.0, z0 + 1.8, z1 - 1.8
            self.box((ix0, ye + 1.2, iz0), (ix1, ye + 2.6, iz1), m_plaster(wall), shadow=False)
            self.hip_roof(ix0, ix1, iz0, iz1, ye + 2.4, 1.7, rm, ov=1.0)
        else:
            self.hip_roof(x0, x1, z0, z1, ye, 2.6, rm, ov=1.1)

    def pillar(self, x, z, h, w=0.8, mat=None):
        mat = mat or m_plaster((0.86, 0.8, 0.66), 0.2)
        self.box((x - w / 2, 0, z - w / 2), (x + w / 2, h, z + w / 2), mat)
        self.box((x - w / 2 - 0.12, h, z - w / 2 - 0.12), (x + w / 2 + 0.12, h + 0.3, z + w / 2 + 0.12), mat)
        self.box((x - 0.2, h + 0.3, z - 0.2), (x + 0.2, h + 0.9, z + 0.2), mat)

    def sign(self, name, yaw_deg=38, dist=5.2):
        img = make_board(name)
        th = math.radians(yaw_deg)
        c = np.array([dist * math.sin(th), 0, dist * math.cos(th)], F)
        right = np.array([math.cos(th), 0, -math.sin(th)], F)
        w, h = 2.6, 0.98
        for s in (-1, 1):
            p = c + right * s * (w / 2 - 0.15)
            self.add(Cyl(float(p[0]), float(p[2]), 0.06, 0, 1.0 + h + 0.05, m_flat((0.25, 0.17, 0.1))))
        o = c - right * (w / 2) + np.array([0, 1.0, 0], F)
        self.add(Quad(o, right * w, (0, h, 0), m_image(img)))


def make_board(name):
    W_, H_ = 1300, 490
    im = Image.new("RGB", (W_, H_), (92, 58, 34))
    dr = ImageDraw.Draw(im)
    dr.rectangle([18, 18, W_ - 19, H_ - 19], fill=(246, 236, 214), outline=(201, 154, 69), width=8)
    fonts = "C:/Windows/Fonts/"

    def font(f, s):
        try:
            return ImageFont.truetype(fonts + f, s)
        except OSError:
            return ImageFont.load_default()
    f1, f2, f3 = font("arialbd.ttf", 62), font("arialbd.ttf", 74), font("arial.ttf", 44)
    size = 74
    while dr.textlength(name, font=f2) > W_ - 110 and size > 36:
        size -= 4
        f2 = font("arialbd.ttf", size)
    for text, f, y, c in (
        ("ẢNH 360° MẪU – MINH HỌA", f1, 70, (176, 48, 34)),
        (name, f2, 200, (63, 39, 22)),
        ("Thay bằng ảnh chụp thực tế tại di tích", f3, 345, (110, 90, 70)),
    ):
        w = dr.textlength(text, font=f)
        dr.text(((W_ - w) / 2, y), text, font=f, fill=c)
    return im


# ---------------------------------------------------------------- ground textures

def g_grass(X, Z):
    n = fbm(X * 0.45, Z * 0.45, 4)
    m = fbm(X * 3, Z * 3, 2)
    c = mix(col(0.24, 0.4, 0.14)[None], col(0.42, 0.5, 0.2)[None], n)
    return c * (0.8 + 0.35 * m)[:, None]


def g_dirt(X, Z):
    n = fbm(X * 0.8, Z * 0.8, 4)
    c = mix(col(0.5, 0.38, 0.25)[None], col(0.62, 0.5, 0.36)[None], n)
    grass = smooth(0.6, 0.75, fbm(X * 0.5 + 5, Z * 0.5, 3))
    return mix(c, g_grass(X, Z), grass * 0.7)


def g_tiles(size=0.45, base=(0.6, 0.33, 0.22)):
    base = col(*base)

    def f(X, Z):
        ix, iz = np.floor(X / size), np.floor(Z / size)
        fx, fz = X / size - ix, Z / size - iz
        h = hash2(ix, iz)
        c = base[None] * (0.78 + 0.35 * h)[:, None] * (0.85 + 0.2 * fbm(X * 2, Z * 2, 2))[:, None]
        grout = (np.minimum(np.minimum(fx, 1 - fx), np.minimum(fz, 1 - fz)) * size) < 0.025
        c[grout] = col(0.55, 0.52, 0.46)
        moss = smooth(0.62, 0.8, fbm(X * 0.4, Z * 0.4, 3)) * 0.5
        return mix(c, col(0.3, 0.36, 0.2)[None], moss)
    return f


def g_stone_path(X, Z):
    return g_tiles(0.7, (0.6, 0.58, 0.53))(X, Z)


def g_flowers(X, Z):
    c = g_grass(X, Z)
    n = fbm(X * 4, Z * 4, 2)
    red = n > 0.62
    c[red] = mix(col(0.8, 0.2, 0.15)[None], col(0.95, 0.75, 0.2)[None], (n[red] - 0.62) * 3)
    return c


def rect(x0, z0, x1, z1):
    return lambda X, Z: (X >= x0) & (X <= x1) & (Z >= z0) & (Z <= z1)


def circle(cx, cz, r):
    return lambda X, Z: (X - cx) ** 2 + (Z - cz) ** 2 <= r * r


# ---------------------------------------------------------------- scene builders

def build_den(s, name, variant):
    wide = variant == "dinh"
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass),
                (rect(-9, -7, 9, 14), g_tiles()),
                (rect(-1.6, -30, 1.6, -7), g_stone_path)]
    stone = m_stone_blocks((0.62, 0.6, 0.55), moss=0.25)
    for sx in (-9.6, 9.0):
        s.box((sx, 0, -7), (sx + 0.6, 1.1, 14), stone)
    s.box((-9.6, 0, -7.6), (-1.6, 1.1, -7), stone)
    s.box((1.6, 0, -7.6), (9.6, 1.1, -7), stone)
    s.hall(0, 14.5, 18 if wide else 13, 9 if wide else 8, tiers=1 if wide else 2,
           wall=(0.84, 0.74, 0.52) if wide else (0.86, 0.68, 0.4))
    # nghi môn
    for x, h in ((-3.4, 4.6), (3.4, 4.6), (-6.4, 3.3), (6.4, 3.3)):
        s.pillar(x, 5.5, h)
    # incense altar / stele in the courtyard
    s.box((-0.7, 0, 9.3), (0.7, 1.0, 10.3), m_stone_blocks((0.55, 0.53, 0.5), 0.4, 0.25, 0.1))
    s.box((-0.45, 1.0, 9.55), (0.45, 1.5, 10.05), m_flat((0.35, 0.3, 0.25)))
    # side buildings (tả vu / hữu vu)
    for xc in (-13.5, 13.5):
        s.hall(xc, 4.0, 5.5, 9, wall_h=2.6, plinth=0.3, tiers=1, cols=False)
    s.tree(-11.5, 13, 1.6)  # old banyan
    s.trees_around(16, 18, 45, avoid=lambda x, z: abs(x) < 10 and -10 < z < 28)
    s.trees_around(8, 9, 14, avoid=lambda x, z: z > -9 or abs(x) < 3)


def build_chua(s, name, variant):
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass),
                (rect(-10, 13, 10, 24), g_tiles(0.5, (0.62, 0.42, 0.3))),
                (rect(-2.2, -25, 2.2, 13), g_stone_path)]
    plaster = m_plaster((0.88, 0.8, 0.6), 0.25)
    zg = 9.0
    for x0, x1 in ((-5.8, -4.6), (-2.6, -1.5), (1.5, 2.6), (4.6, 5.8)):
        s.box((x0, 0, zg), (x1, 3.6, zg + 2.2), plaster)
    s.box((-5.8, 3.0, zg), (5.8, 4.2, zg + 2.2), plaster)           # centre lintel band
    s.box((-4.6, 2.5, zg), (-2.6, 3.0, zg + 2.2), plaster)
    s.box((2.6, 2.5, zg), (4.6, 3.0, zg + 2.2), plaster)
    s.box((-1.5, 4.2, zg + 0.2), (1.5, 5.4, zg + 2.0), plaster)       # gác chuông
    rm = m_roof((0.48, 0.22, 0.13))
    s.hip_roof(-5.8, 5.8, zg, zg + 2.2, 4.2, 1.2, rm, ov=0.8)
    s.hip_roof(-1.5, 1.5, zg + 0.2, zg + 2.0, 5.4, 1.2, rm, ov=0.8)
    # low walls either side of the gate
    for sx0, sx1 in ((-16, -5.8), (5.8, 16)):
        s.box((sx0, 0, zg + 0.6), (sx1, 1.6, zg + 1.2), plaster)
    s.hall(0, 24, 15, 9, tiers=2, wall=(0.9, 0.75, 0.45), roof=(0.46, 0.2, 0.12))
    # stupa
    stone = m_stone_blocks((0.62, 0.6, 0.55), 0.45, 0.3, 0.3)
    for i, (w, h) in enumerate(((1.6, 0.9), (1.3, 0.9), (1.05, 0.8), (0.85, 0.7), (0.65, 0.6))):
        y = sum(hh for _, hh in ((1.6, 0.9), (1.3, 0.9), (1.05, 0.8), (0.85, 0.7), (0.65, 0.6))[:i])
        s.box((-9 - w / 2, y, 4 - w / 2), (-9 + w / 2, y + h, 4 + w / 2), stone)
    s.tree(8, 4, 1.7)  # bodhi tree
    s.trees_around(18, 16, 45, avoid=lambda x, z: abs(x) < 9 and -5 < z < 35)
    s.trees_around(6, 8, 13, avoid=lambda x, z: z > -6 or abs(x) < 3)


def build_don(s, name, variant):
    R = 13.0
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_dirt),
                (lambda X, Z: X * X + Z * Z > (R + 0.5) ** 2, g_grass),
                (rect(-1.4, 0, 1.4, 60), g_dirt)]
    stone = m_stone_blocks((0.5, 0.47, 0.42), 0.7, 0.38, 0.45)
    s.add(RingWall(R, 2.3, 7.5, stone))
    gw = R * math.sin(math.radians(7.5))
    for sx in (-1, 1):
        x0, x1 = sorted((sx * gw, sx * (gw + 1.1)))
        s.box((x0, 0, R - 0.7), (x1, 3.5, R + 0.7), stone)
    s.box((-gw - 1.1, 3.0, R - 0.7), (gw + 1.1, 3.7, R + 0.7), stone)
    s.hip_roof(-gw - 1.1, gw + 1.1, R - 0.7, R + 0.7, 3.7, 0.9, m_roof((0.42, 0.24, 0.16)), ov=0.5)
    # memorial stele inside the fort
    th = math.radians(-50)
    cx, cz = 7 * math.sin(th), 7 * math.cos(th)
    s.box((cx - 1.2, 0, cz - 0.8), (cx + 1.2, 0.5, cz + 0.8), stone)
    s.box((cx - 0.7, 0.5, cz - 0.25), (cx + 0.7, 2.4, cz + 0.25), m_flat((0.32, 0.31, 0.3)))
    s.tree(-6, -7, 1.3)
    s.trees_around(26, R + 3, 40)
    s.hill_amp = 1.3


def build_cave(s, name, variant):
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass),
                (rect(-1.5, -30, 1.5, 13.5), g_stone_path)]
    rock = m_rock()
    s.box((-40, 0, 14), (40, 32, 60), rock, shadow=False)

    def cliff(u, v, P):  # dark cave mouth on the cliff face
        c = rock(u, v, P)
        ex = P[:, 0] / 3.4
        ey = P[:, 1] / 4.6
        edge = ex * ex + ey * ey + 0.25 * (fbm(P[:, 0] * 1.5, P[:, 1] * 1.5, 3) - 0.5)
        inside = (edge < 1.0) & (P[:, 2] < 14.05)
        c[inside] = col(0.03, 0.025, 0.02) * (1 + 3 * np.clip(1 - edge[inside], 0, 1))[:, None] * 0.5
        return c
    s.prims[-1].mat = cliff
    for i in range(14):
        x = s.rng.uniform(-30, 30)
        if abs(x) < 4:
            continue
        r_ = s.rng.uniform(1.0, 3.5)
        s.add(Sphere((x, r_ * 0.6, s.rng.uniform(11, 14)), r_, rock))
    for x in (-3.2, 3.2):
        s.add(Sphere((x, 0.5, 12.5), 1.0, rock))
    s.trees_around(16, 8, 35, avoid=lambda x, z: z > 6 or abs(x) < 3)
    s.karst = True
    s.hill_amp = 2.2


def build_pond(s, name, variant):
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass),
                (lambda X, Z: ((X / 13) ** 2 + ((Z - 15) / 9) ** 2 <= 1.12) & ((X / 13) ** 2 + ((Z - 15) / 9) ** 2 > 1.0), g_stone_path),
                (rect(-1.5, -20, 1.5, 5.2), g_stone_path)]
    s.water = lambda X, Z: (X / 13) ** 2 + ((Z - 15) / 9) ** 2 <= 1.0
    s.hall(0, 27, 7, 6, wall_h=2.8, plinth=0.6, tiers=1, wall=(0.85, 0.75, 0.55))
    s.trees_around(20, 14, 40, avoid=lambda x, z: (x / 15) ** 2 + ((z - 15) / 11) ** 2 < 1 or (abs(x) < 3 and z < 0))
    s.trees_around(4, 7, 9, avoid=lambda x, z: z > -3)


def build_cemetery(s, name, variant):
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass), (rect(-1.2, -20, 1.2, 30), g_dirt)]
    grave = m_flat((0.78, 0.77, 0.73))
    for row in range(5):
        z = 7 + row * 3.2
        for k in range(-4, 5):
            if k == 0:
                continue
            x = k * 2.4 + s.rng.uniform(-0.2, 0.2)
            s.box((x - 0.55, 0, z - 1.0), (x + 0.55, 0.35, z + 1.0), grave)
            s.box((x - 0.45, 0.35, z + 0.75), (x + 0.45, 1.2, z + 0.95), grave)
            if s.rng.rand() < 0.6:
                s.box((x - 0.06, 1.2, z + 0.8), (x + 0.06, 1.85, z + 0.9), grave)
                s.box((x - 0.25, 1.5, z + 0.8), (x + 0.25, 1.62, z + 0.9), grave)
    wall = m_stone_blocks((0.6, 0.58, 0.53), moss=0.4)
    s.box((-12, 0, 24), (12, 1.0, 24.5), wall)
    s.trees_around(22, 14, 40, avoid=lambda x, z: abs(x) < 12 and 3 < z < 25)
    s.hill_amp = 1.2


def build_memorial(s, name, variant):
    s.zones += [(lambda X, Z: np.ones_like(X, bool), g_grass),
                (rect(-8, 4, 8, 18), g_tiles(0.6, (0.7, 0.66, 0.58))),
                (rect(-1.8, -25, 1.8, 4), g_stone_path),
                (rect(-7.5, 5.5, -3.5, 9), g_flowers), (rect(3.5, 5.5, 7.5, 9), g_flowers)]
    stone = m_flat((0.5, 0.48, 0.45))
    # stele / monument
    s.box((-1.6, 0, 9.4), (1.6, 0.6, 11.0), m_stone_blocks((0.6, 0.58, 0.54), 0.5, 0.3, 0.05))
    s.box((-1.1, 0.6, 9.8), (1.1, 3.6, 10.5), stone)
    s.box((-1.3, 3.6, 9.7), (1.3, 3.9, 10.6), stone)
    s.hall(0, 18.5, 16, 9, wall_h=3.6, tiers=2, wall=(0.9, 0.82, 0.62), roof=(0.5, 0.25, 0.15))
    s.trees_around(18, 14, 42, avoid=lambda x, z: abs(x) < 10 and 0 < z < 30)
    s.trees_around(6, 8, 12, avoid=lambda x, z: z > -4 or abs(x) < 3)


BUILDERS = {"den": build_den, "chua": build_chua, "don": build_don, "cave": build_cave,
            "pond": build_pond, "cemetery": build_cemetery, "memorial": build_memorial}


# ---------------------------------------------------------------- renderer

def windows(prim, W, H):
    """Pixel windows (y-slice, x-slice) that can contain the primitive."""
    bb = prim.bbox()
    if bb is None:
        return [(slice(0, H), slice(0, W))]
    lo, hi = bb
    cx = np.clip(0, lo[0], hi[0])
    cz = np.clip(0, lo[2], hi[2])
    dmin = math.hypot(cx, cz)
    corners = [(lo[0], lo[2]), (lo[0], hi[2]), (hi[0], lo[2]), (hi[0], hi[2])]
    dmax = max(math.hypot(x, z) for x, z in corners)
    if dmin < 0.3:
        return [(slice(0, H), slice(0, W))]
    p_hi = math.atan2(hi[1] - CAM_H, dmin if hi[1] > CAM_H else dmax)
    p_lo = math.atan2(lo[1] - CAM_H, dmin if lo[1] < CAM_H else dmax)
    y0 = max(0, int((0.5 - p_hi / math.pi) * H) - 2)
    y1 = min(H, int((0.5 - p_lo / math.pi) * H) + 3)
    mid = math.atan2((lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2)
    rel = [((math.atan2(x, z) - mid + math.pi) % (2 * math.pi)) - math.pi for x, z in corners]
    a0, a1 = mid + min(rel), mid + max(rel)
    x0 = int(math.floor((a0 / (2 * math.pi) + 0.5) * W)) - 2
    x1 = int(math.ceil((a1 / (2 * math.pi) + 0.5) * W)) + 3
    if x1 - x0 >= W:
        return [(slice(y0, y1), slice(0, W))]
    out = []
    for a, b in ((x0, x1), (x0 + W, x1 + W), (x0 - W, x1 - W)):
        a, b = max(a, 0), min(b, W)
        if b > a:
            out.append((slice(y0, y1), slice(a, b)))
    return out


def sky_color(dx, dy, dz, rng_phase):
    t = np.clip(dy, 0, 1)
    c = mix(col(0.78, 0.85, 0.9)[None], col(0.28, 0.5, 0.82)[None], np.sqrt(t))
    sun = np.clip(dx * SUN[0] + dy * SUN[1] + dz * SUN[2], 0, 1)
    c = c + (col(1.0, 0.9, 0.7)[None] * (sun ** 64 * 1.5 + sun ** 6 * 0.15)[:, None])
    up = dy > 0.015
    k = np.where(up, 1.0 / np.maximum(dy, 0.015), 0)
    u, v = dx * k * 0.9 + rng_phase, dz * k * 0.9
    cl = smooth(0.48, 0.75, fbm(u, v, 5)) * smooth(0.015, 0.12, dy)
    shade = 0.82 + 0.25 * fbm(u * 2 + 4, v * 2, 3)
    return mix(c, col(1, 1, 1)[None] * shade[:, None], cl * 0.92)


def render(scene, W, H):
    t0 = time.time()
    yy, xx = np.mgrid[0:H, 0:W].astype(F)
    th = (xx + 0.5) / W * 2 * np.pi - np.pi
    ph = np.pi / 2 - (yy + 0.5) / H * np.pi
    cp = np.cos(ph)
    D = np.stack([np.sin(th) * cp, np.sin(ph), np.cos(th) * cp]).astype(F)  # (3,H,W)
    del yy, xx, cp
    C = np.zeros((H, W, 3), F)
    T = np.full((H, W), np.inf, F)
    rng = scene.rng

    # --- sky + distant hills
    up = D[1] >= 0
    dflat = D[:, up]
    C[up] = sky_color(dflat[0], dflat[1], dflat[2], rng.rand() * 50)
    phases = rng.rand(3, 24) * 2 * np.pi
    th_u = th[up]
    ph_u = ph[up]
    for layer, (base_deg, amp_deg, tint, fade) in enumerate((
            (3.0, 4.0, (0.36, 0.46, 0.44), 0.32), (1.4, 2.8, (0.24, 0.36, 0.2), 0.1))):
        e = np.zeros_like(th_u)
        for k in range(1, 24):
            e += np.sin(k * th_u + phases[layer, k]) / (k ** (1.0 if scene.karst else 1.25))
        if scene.karst:
            e = np.abs(e) ** 0.8
        e = np.radians(base_deg + amp_deg * scene.hill_amp * (0.5 + 0.35 * e))
        hit = ph_u < e
        n = fbm(th_u[hit] * 80, ph_u[hit] * 80, 3)
        hc = col(*tint)[None] * (0.8 + 0.35 * n)[:, None]
        hz = col(0.75, 0.82, 0.86)[None]
        hc = mix(hc, hz, fade + 0.15 * (ph_u[hit] / np.maximum(e[hit], 1e-3)))
        sub = C[up]
        sub[hit] = hc
        C[up] = sub

    # --- ground
    dn = ~up
    dg = D[:, dn]
    tg = CAM_H / -dg[1]
    X, Z = dg[0] * tg, dg[2] * tg
    G = np.zeros((len(X), 3), F)
    for mask_fn, tex in scene.zones:
        m = mask_fn(X, Z)
        if m.any():
            G[m] = tex(X[m], Z[m])
    if scene.water is not None:
        m = scene.water(X, Z)
        if m.any():
            r = dg[:, m].copy()
            r[1] = -r[1] + 0.03 * (fbm(X[m] * 2, Z[m] * 6, 3) - 0.5)
            refl = sky_color(r[0], np.maximum(r[1], 0.001), r[2], 0)
            G[m] = mix(col(0.12, 0.2, 0.17)[None], refl, 0.55)
    occ = np.zeros(len(X), F)
    for bx, bz, br, st in scene.blobs:
        d2 = (X - bx) ** 2 + (Z - bz) ** 2
        near = d2 < (br * 3) ** 2
        occ[near] += st * np.exp(-d2[near] / (br * br))
    for x0, z0, x1, z1, st in scene.rects:
        ddx = np.maximum(np.maximum(x0 - X, X - x1), 0)
        ddz = np.maximum(np.maximum(z0 - Z, Z - z1), 0)
        dist = np.sqrt(ddx * ddx + ddz * ddz)
        near = dist < 3
        occ[near] += 0.4 * st * np.exp(-dist[near] / 0.9)
    G *= (1.02 - np.clip(occ, 0, 0.7))[:, None]
    fog = 1 - np.exp(-tg / 380)
    G = mix(G, col(0.74, 0.8, 0.84)[None], fog)
    C[dn] = G
    T[dn] = tg

    # --- objects
    for prim in scene.prims:
        for ys, xs in windows(prim, W, H):
            d = D[:, ys, xs]
            shp = d.shape[1:]
            df = d.reshape(3, -1)
            t, aux = prim.intersect(df)
            Tw = T[ys, xs].reshape(-1)
            m = t < Tw
            if not m.any():
                continue
            tm = t[m]
            dm = df[:, m]
            P = (np.array([0, CAM_H, 0], F)[:, None] + tm * dm).T
            rgb, n = prim.shade(P, {k: v[m] for k, v in aux.items()}, dm)
            diff = np.clip(n @ SUN, 0, 1)
            light = 0.38 + 0.14 * n[:, 1] + 0.72 * diff
            out = rgb * light[:, None] * col(1.0, 0.97, 0.92)[None]
            fog = 1 - np.exp(-tm / 380)
            out = mix(out, col(0.74, 0.8, 0.84)[None], fog)
            Cw = C[ys, xs].reshape(-1, 3)
            Cw[m] = out
            Tw[m] = tm
            C[ys, xs] = Cw.reshape(shp + (3,))
            T[ys, xs] = Tw.reshape(shp)
    img = np.clip(C, 0, 1) ** (1 / 2.2)
    print(f"    rendered {W}x{H} in {time.time() - t0:.1f}s", flush=True)
    return Image.fromarray((img * 255 + 0.5).astype(np.uint8))


# ---------------------------------------------------------------- main

def scene_for(site):
    t = SCENE_TYPE.get(site["id"]) or CATEGORY_TYPE.get(site["category"], "memorial")
    seed = zlib.crc32(site["id"].encode()) & 0xFFFF
    s = Scene(seed)
    variant = "dinh" if site["name"].startswith("Đình") else ""
    BUILDERS[t](s, site["name"], variant)
    s.sign(site["name"], yaw_deg=36 + s.rng.uniform(-6, 6))
    return s, t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--width", type=int, default=4096)
    ap.add_argument("--ss", type=float, default=1.5, help="supersampling factor (anti-aliasing)")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    tour = json.load(open("data/tour.json", encoding="utf8"))
    for site in tour["sites"]:
        real = [sc for sc in site["scenes"] if not sc.get("sample")]
        if a.ids and site["id"] not in a.ids:
            continue
        if real and not a.ids:
            continue  # already has real 360 photos
        out_dir = os.path.join("panos", site["id"])
        out = os.path.join(out_dir, "toan-canh.jpg")
        if os.path.exists(out) and not a.force:
            print(f"skip {site['id']} (đã có {out})")
            continue
        s, kind = scene_for(site)
        print(f"{site['id']} [{kind}]", flush=True)
        W = int(a.width * a.ss)
        img = render(s, W, W // 2)
        if a.ss != 1:
            img = img.resize((a.width, a.width // 2), Image.LANCZOS)
        os.makedirs(out_dir, exist_ok=True)
        img.save(out, quality=86, optimize=True)
        img.resize((320, 160), Image.LANCZOS).save(os.path.join(out_dir, "toan-canh-thumb.jpg"), quality=85)


if __name__ == "__main__":
    sys.exit(main())
