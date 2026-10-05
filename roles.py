"""Colour-tag role labelling, independent of camera/model code.

Each role is given a tag colour. For every tracked person, this finds how many
pixels inside their box match a role's colour and assigns the best match. It is
anonymous (colour + box only, no identity) and is a visual aid, not an alert.

Works best with bright, well-separated tag colours under even lighting; washed
out, dark, or near-white tags are unreliable, as is anything colour detection.
"""
import cv2
import numpy as np

MIN_RATIO = 0.004   # tag pixels must cover at least this share of the person box
MIN_PIXELS = 50     # absolute floor so tiny/distant boxes do not false-match
HUE_TOL = 10        # OpenCV hue is 0..179
SAT_TOL = 70
VAL_TOL = 70


def _hex_to_bgr(value):
    text = value.lstrip('#')
    r, g, b = int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
    return (b, g, r)


def _ranges_for(bgr):
    hsv = cv2.cvtColor(np.uint8([[list(bgr)]]), cv2.COLOR_BGR2HSV)[0][0]
    h, s, v = int(hsv[0]), int(hsv[1]), int(hsv[2])
    s_lo, v_lo = max(60, s - SAT_TOL), max(60, v - VAL_TOL)
    lo, hi = h - HUE_TOL, h + HUE_TOL
    spans = []
    if lo < 0:                       # red wraps around the hue circle
        spans += [(0, hi), (180 + lo, 179)]
    elif hi > 179:
        spans += [(lo, 179), (0, hi - 180)]
    else:
        spans.append((lo, hi))
    return [(np.array([a, s_lo, v_lo]), np.array([b, 255, 255])) for a, b in spans]


class RoleTagger:
    def __init__(self):
        self.roles = []

    def set_roles(self, roles):
        parsed = []
        for role in roles or []:
            name = str(role.get('name', '')).strip()[:40]
            color = role.get('color')
            if not name or not isinstance(color, str) or len(color.lstrip('#')) != 6:
                continue
            try:
                bgr = _hex_to_bgr(color)
            except ValueError:
                continue
            parsed.append({'name': name, 'bgr': bgr, 'ranges': _ranges_for(bgr)})
        self.roles = parsed

    def classify(self, frame, persons):
        if not self.roles or not persons:
            return {}
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        height, width = hsv.shape[:2]
        masks = []
        for role in self.roles:
            mask = None
            for lo, hi in role['ranges']:
                part = cv2.inRange(hsv, lo, hi)
                mask = part if mask is None else cv2.bitwise_or(mask, part)
            masks.append(mask)
        result = {}
        for pid, box in persons.items():
            x1, y1 = max(0, box[0]), max(0, box[1])
            x2, y2 = min(width, box[2]), min(height, box[3])
            area = max(1, (x2 - x1) * (y2 - y1))
            best, best_count = None, 0
            for role, mask in zip(self.roles, masks):
                count = int(np.count_nonzero(mask[y1:y2, x1:x2]))
                if count > best_count:
                    best, best_count = role, count
            if best and best_count >= MIN_PIXELS and best_count / area >= MIN_RATIO:
                result[pid] = {'name': best['name'], 'color': best['bgr']}
        return result
