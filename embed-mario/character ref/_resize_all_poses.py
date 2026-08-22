import os
import numpy as np
from PIL import Image, ImageOps

root = r"C:\Users\missm\Projects\wtfispugdoing\embed-mario\character ref"
SKIP_CHARS = {"Birdo", "Toad"}
SIZE = (1025, 1025)

resized = 0
skipped = 0

for char in sorted(os.listdir(root)):
    if char in SKIP_CHARS:
        continue
    poses = os.path.join(root, char, "poses")
    if not os.path.isdir(poses):
        continue
    for name in sorted(os.listdir(poses)):
        if not name.lower().endswith(".png"):
            continue
        path = os.path.join(poses, name)
        im = Image.open(path).convert("RGB")
        if im.size == SIZE:
            skipped += 1
            continue
        arr = np.array(im)
        h, w = arr.shape[:2]
        corners = np.stack(
            [arr[0, 0], arr[0, w - 1], arr[h - 1, 0], arr[h - 1, w - 1]]
        )
        bg = tuple(int(x) for x in np.median(corners, axis=0))
        out = ImageOps.pad(
            im,
            SIZE,
            method=Image.Resampling.LANCZOS,
            color=bg,
            centering=(0.5, 0.5),
        )
        out.save(path, format="PNG", optimize=True)
        resized += 1
        print(f"{char}/{name:32s} {w}x{h} -> {out.size[0]}x{out.size[1]}")

print(f"\nresized={resized} already_1025={skipped}")
