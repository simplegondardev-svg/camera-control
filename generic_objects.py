"""Wrist-anchored generic object detection, independent of trained categories.

YOLO only boxes its ~80 trained classes. This finds an object a person is
holding regardless of class: a foreground blob (vs a learned background) that
sits at a wrist and is not skin-coloured. Each blob is given a stable id and fed
into the same pickup/concealment pipeline as named objects.

This is deliberately scoped to the hand to limit noise, but it is still a
heuristic: shadows, sleeves, lighting changes and skin-toned objects can cause
false blobs or misses. It is an aid for review, not a reliable detector.
"""
import cv2
import numpy as np

# YCrCb skin range, subtracted so the bare hand is not mistaken for an object.
SKIN_LOWER = np.array([0, 133, 77], np.uint8)
SKIN_UPPER = np.array([255, 173, 127], np.uint8)
WRIST_REGION = 0.14   # half-size of the hand search window, as a share of the short side
MIN_AREA = 0.03       # blob must fill at least this share of the window
MAX_AREA = 0.75       # ...and no more (a full window is usually the arm, not a held item)
FORGET = 1.0          # drop a tracked blob unseen this many seconds
FIRST_ID = 100000     # generic ids start high so they never collide with YOLO track ids


def _iou(a, b):
    inter = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
    return inter / union if union > 0 else 0


class GenericObjectDetector:
    def __init__(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=400, varThreshold=40, detectShadows=True)
        self.blobs = {}        # gid -> {'box', 'last'}
        self.counter = FIRST_ID

    def update(self, frame, wrists, now):
        height, width = frame.shape[:2]
        foreground = cv2.inRange(self.bg.apply(frame), 250, 255)  # 127 = shadow, dropped
        skin = cv2.dilate(cv2.inRange(cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb), SKIN_LOWER, SKIN_UPPER),
                          None, iterations=2)
        candidate = cv2.morphologyEx(cv2.bitwise_and(foreground, cv2.bitwise_not(skin)),
                                     cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        reach = int(min(height, width) * WRIST_REGION)
        detections = []
        for wx, wy, _ in wrists:
            x1, y1 = max(0, wx - reach), max(0, wy - reach)
            x2, y2 = min(width, wx + reach), min(height, wy + reach)
            window = candidate[y1:y2, x1:x2]
            if window.size == 0:
                continue
            contours, _ = cv2.findContours(window, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            best = max(contours, key=cv2.contourArea)
            area = cv2.contourArea(best)
            window_area = window.shape[0] * window.shape[1]
            if area < MIN_AREA * window_area or area > MAX_AREA * window_area:
                continue
            bx, by, bw, bh = cv2.boundingRect(best)
            detections.append((x1 + bx, y1 + by, x1 + bx + bw, y1 + by + bh))

        self.blobs = {gid: b for gid, b in self.blobs.items() if now - b['last'] < FORGET}
        result, used = {}, set()
        for box in detections:
            match = next((gid for gid, b in self.blobs.items()
                          if gid not in used and _iou(box, b['box']) > 0.3), None)
            if match is None:
                self.counter += 1
                match = self.counter
            used.add(match)
            self.blobs[match] = {'box': box, 'last': now}
            result[match] = {'label': 'object', 'box': box}
        return result
