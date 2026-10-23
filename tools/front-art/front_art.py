"""Cut the UFO Defense cover scan into the front page's layers: the ship and the title, upscaled with Real-ESRGAN.

usage: front_art.py <cover.jpg> <ship-mask.png> <RealESRGAN_x4plus.pth> <out dir>
  cover.jpg      the US DOS front cover (682x800 scan)
  ship-mask.png  BiRefNet mask of the frame crop (126,106)-(657,700), from ship_mask.py
"""
import sys
from pathlib import Path
import numpy as np
import cv2
import torch
from PIL import Image
from spandrel import ModelLoader

src, mask_path, model_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
out.mkdir(parents=True, exist_ok=True)
img = np.asarray(Image.open(src).convert("RGB")).copy()
H, W, _ = img.shape
CROP0 = (126, 106)

# the box's thin white frame runs through the lettering: paint it out first
# (2px lines: rows 104-105 and columns 124-125 on this scan, from the frame's top-left corner)
lines = np.zeros((H, W), np.uint8)
lines[103:350, 123:127] = 255  # left frame line
lines[103:107, 123:360] = 255  # top frame line
img = cv2.inpaint(img, lines, 2, cv2.INPAINT_TELEA)
f = img.astype(np.float32)
R, G, B = f[..., 0], f[..., 1], f[..., 2]

m = np.asarray(Image.open(mask_path).convert("L")).astype(np.float32) / 255
ship_a = np.zeros((H, W), np.float32)
ship_a[CROP0[1]:CROP0[1] + m.shape[0], CROP0[0]:CROP0[0] + m.shape[1]] = m
ship_a = cv2.erode(ship_a, np.ones((2, 2), np.uint8))

whiteness = np.clip((np.minimum(np.minimum(R, G), B) - 70) / 110, 0, 1)
greenness = np.clip((G - np.maximum(R, B) - 12) / 40, 0, 1) * np.clip((G - 40) / 40, 0, 1)
title_a = np.maximum(whiteness, greenness)
region = np.zeros((H, W), np.float32)
region[20:345, 0:350] = 1
title_a *= region * (ship_a < 0.05)

model = ModelLoader().load_from_file(str(model_path)).eval()

def upscale(rgb: np.ndarray) -> np.ndarray:
    t = torch.from_numpy(rgb.astype(np.float32) / 255).permute(2, 0, 1)[None]
    with torch.no_grad():
        y = model(t)
    return (y[0].permute(1, 2, 0).clamp(0, 1).numpy() * 255).round().astype(np.uint8)

def layer(alpha: np.ndarray, name: str, scale: int = 3):
    ys, xs = np.nonzero(alpha > 0.02)
    y0, y1, x0, x1 = max(0, ys.min() - 4), min(H, ys.max() + 5), max(0, xs.min() - 4), min(W, xs.max() + 5)
    rgb4 = upscale(img[y0:y1, x0:x1])
    a = cv2.resize(alpha[y0:y1, x0:x1], (rgb4.shape[1], rgb4.shape[0]), interpolation=cv2.INTER_CUBIC)
    a = cv2.GaussianBlur(np.clip(a, 0, 1), (0, 0), 0.8)
    rgba = Image.fromarray(np.dstack([rgb4, (a * 255).astype(np.uint8)]), "RGBA")
    rgba = rgba.resize((round((x1 - x0) * scale), round((y1 - y0) * scale)), Image.LANCZOS)
    rgba.save(out / f"{name}.webp", quality=90, method=6)
    print(name, rgba.size, "from", (x0, y0, x1, y1))

layer(ship_a, "ship")
layer(title_a, "title")
