"""Anonymous face-state detection: physical expression signals, not emotions.

Reports objective facial signals per visible face -- smiling, frowning, mouth
open, eyes closed, and whether the face is turned toward the camera -- using
MediaPipe's Face Landmarker blendshapes. It deliberately does NOT infer emotions
("happy", "angry"): a smile shape is reported as a smile, nothing more.

It is anonymous: no identity, no face database, no stored images -- only the
per-frame on/off signals and a bounding box for drawing.
"""
import threading
import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

# Thresholds on blendshape scores (0..1). Tune against the real camera.
SMILE_T = 0.40
FROWN_T = 0.30
EYES_CLOSED_T = 0.50
MOUTH_OPEN_T = 0.40
FACING_T = 0.35   # nose offset from eye-midline, as a share of inter-eye distance

NOSE_TIP, LEFT_EYE_OUTER, RIGHT_EYE_OUTER = 1, 33, 263


class FaceStateReader:
    def __init__(self, model_path):
        if not Path(model_path).is_file():
            raise FileNotFoundError(f'Missing face model: {Path(model_path).name}')
        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(model_path)),
            output_face_blendshapes=True,
            num_faces=2,
            running_mode=vision.RunningMode.IMAGE,
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(options)

    def read(self, frame_bgr):
        height, width = frame_bgr.shape[:2]   # original dims; landmarks are normalized 0..1
        small = frame_bgr
        if max(height, width) > 640:          # downscale for the model to cut CPU cost
            factor = 640 / max(height, width)
            small = cv2.resize(frame_bgr, (max(1, int(width * factor)), max(1, int(height * factor))))
        image = mp.Image(image_format=mp.ImageFormat.SRGB,
                         data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        result = self.landmarker.detect(image)
        faces = []
        for index, landmarks in enumerate(result.face_landmarks):
            scores = {}
            if index < len(result.face_blendshapes):
                for category in result.face_blendshapes[index]:
                    scores[category.category_name] = category.score
            pick = lambda name: scores.get(name, 0.0)
            xs = [point.x for point in landmarks]
            ys = [point.y for point in landmarks]
            facing = True
            try:
                nose, left, right = landmarks[NOSE_TIP], landmarks[LEFT_EYE_OUTER], landmarks[RIGHT_EYE_OUTER]
                span = abs(right.x - left.x) or 1e-6
                facing = abs((nose.x - (left.x + right.x) / 2) / span) < FACING_T
            except IndexError:
                pass
            faces.append({
                'box': (int(min(xs) * width), int(min(ys) * height),
                        int(max(xs) * width), int(max(ys) * height)),
                'smile': (pick('mouthSmileLeft') + pick('mouthSmileRight')) / 2 >= SMILE_T,
                'frown': (pick('browDownLeft') + pick('browDownRight')) / 2 >= FROWN_T,
                'eyes_closed': (pick('eyeBlinkLeft') + pick('eyeBlinkRight')) / 2 >= EYES_CLOSED_T,
                'mouth_open': pick('jawOpen') >= MOUTH_OPEN_T,
                'facing': facing,
            })
        return faces


class FaceStateWorker:
    """Runs face-state inference on a background thread.

    MediaPipe's first real-face inference can block for many seconds (lazy graph
    init), and per-frame cost is non-trivial. Running it off the main loop keeps
    the YOLO frame pipeline and the worker<->server protocol responsive: the main
    loop submits the latest frame and reads whatever result is currently ready.
    """
    def __init__(self, model_path):
        self.model_path = model_path
        self.reader = None
        self.lock = threading.Lock()
        self.latest = None
        self.results = []
        self.enabled = False
        self.error = None
        self.thread = None

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        if self.enabled and self.thread is None:
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        if not self.enabled:
            with self.lock:
                self.results = []

    def submit(self, frame):
        with self.lock:
            self.latest = frame

    def get(self):
        with self.lock:
            return list(self.results)

    def _run(self):
        min_interval = 0.6   # cap to ~1.6 inferences/sec so it never saturates the CPU
        last = 0.0
        while True:
            if not self.enabled:
                time.sleep(0.05)
                continue
            wait = min_interval - (time.monotonic() - last)
            if wait > 0:
                time.sleep(wait)
            with self.lock:
                frame, self.latest = self.latest, None
            if frame is None:
                time.sleep(0.05)
                continue
            last = time.monotonic()
            try:
                if self.reader is None:
                    self.reader = FaceStateReader(self.model_path)
                result = self.reader.read(frame)
                with self.lock:
                    self.results = result
            except Exception as error:
                self.error = str(error)[:150]
                with self.lock:
                    self.results = []


def label_for(state):
    tags = []
    if state['smile']:
        tags.append('smile')
    elif state['frown']:
        tags.append('frown')
    if state['mouth_open']:
        tags.append('mouth open')
    if state['eyes_closed']:
        tags.append('eyes closed')
    if not state['facing']:
        tags.append('looking away')
    return ', '.join(tags) or 'neutral'
