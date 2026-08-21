"""Detect a likely watermark and inpaint only that region. Does not crop or rescale."""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np


def _corner_rois(h: int, w: int) -> list[tuple[int, int, int, int]]:
    mw, mh = int(w * 0.30), int(h * 0.18)
    return [
        (w - mw, h - mh, w, h),
        (0, h - mh, mw, h),
        (w - mw, 0, w, mh),
        (0, 0, mw, mh),
    ]


def _keep_logo_components(binary: np.ndarray, roi_h: int, roi_w: int) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    out = np.zeros_like(binary)
    roi_area = max(roi_h * roi_w, 1)
    min_area = 60
    max_area = int(roi_area * 0.35)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if area < min_area or area > max_area:
            continue
        if bw > roi_w * 0.95 or bh > roi_h * 0.95:
            continue
        out[labels == i] = 255
    return out


def _overlay_mask(gray_roi: np.ndarray) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    tophat = cv2.morphologyEx(gray_roi, cv2.MORPH_TOPHAT, kernel)
    blackhat = cv2.morphologyEx(gray_roi, cv2.MORPH_BLACKHAT, kernel)
    combo = cv2.max(tophat, blackhat)
    combo = cv2.GaussianBlur(combo, (3, 3), 0)
    if int(combo.max()) < 12:
        return np.zeros_like(gray_roi)
    _, binary = cv2.threshold(combo, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return _keep_logo_components(binary, gray_roi.shape[0], gray_roi.shape[1])


def build_mask(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    mask = np.zeros((h, w), np.uint8)

    for x1, y1, x2, y2 in _corner_rois(h, w):
        local = _overlay_mask(gray[y1:y2, x1:x2])
        if int(cv2.countNonZero(local)) == 0:
            continue
        mask[y1:y2, x1:x2] = cv2.max(mask[y1:y2, x1:x2], local)

    coverage = cv2.countNonZero(mask) / max(h * w, 1)
    if coverage == 0 or coverage > 0.08:
        # Typical AI logo sits in the bottom-right. Keep it small so the rest of the art is untouched.
        cw, ch = max(int(w * 0.16), 48), max(int(h * 0.10), 32)
        fallback = np.zeros((h, w), np.uint8)
        fallback[h - ch : h, w - cw : w] = 255
        edges = cv2.Canny(gray[h - ch : h, w - cw : w], 40, 120)
        if cv2.countNonZero(edges) > 40 or coverage == 0:
            mask = fallback
        elif coverage > 0.08:
            mask[:] = 0
            for x1, y1, x2, y2 in _corner_rois(h, w)[:1]:
                local = _overlay_mask(gray[y1:y2, x1:x2])
                mask[y1:y2, x1:x2] = local

    if cv2.countNonZero(mask) == 0:
        cw, ch = max(int(w * 0.14), 40), max(int(h * 0.09), 28)
        mask[h - ch : h, w - cw : w] = 255

    dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    return cv2.dilate(mask, dilate, iterations=1)


def remove_watermark(src: Path, dest: Path) -> None:
    image = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Could not read {src}")

    mask = build_mask(image)
    if cv2.countNonZero(mask) == 0:
        dest.write_bytes(src.read_bytes())
        return

    cleaned = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Same dimensions; JPEG only. No resize/crop.
    ok = cv2.imwrite(str(dest), cleaned, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise SystemExit(f"Could not write {dest}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: remove_watermark.py input.jpg output.jpg")
    remove_watermark(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    main()
