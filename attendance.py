"""Opt-in face liveness, enrollment, and recognition for attendance.

Uses OpenCV's YuNet detector, Open Model Zoo anti-spoof-mn3 model, and SFace
recognizer. Enrolled face embeddings are stored locally in face-db.json.

This is a NAMED, biometric feature and is separate from the anonymous
concealment pipeline. It only runs when the operator turns it on, and every
enrolled person should have given consent. Camera-only recognition and passive
liveness can be wrong; treat results as an aid, not an authority. The liveness
model is not a guarantee against replay or presentation attacks.
"""
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

COSINE = getattr(cv2, 'FaceRecognizerSF_FR_COSINE', 0)
COSINE_THRESHOLD = 0.363   # SFace's recommended same-person cosine threshold
MAX_SAMPLES = 5            # keep a few embeddings per person for robustness
LIVENESS_LIVE_THRESHOLD = 0.60
LIVENESS_SPOOF_THRESHOLD = 0.60
LIVENESS_STABLE_FRAMES = 3
LIVENESS_STABLE_DURATION = 1.0
LIVENESS_RESULT_WINDOW = 5
LIVENESS_MAX_GAP = 2.5

LIVE = 'LIVE'
DISABLED = 'DISABLED'
SPOOF = 'SPOOF / REJECTED'
INCONCLUSIVE = 'INCONCLUSIVE'
CHECKING = 'CHECKING'


def classify_liveness(scores):
    """Map model output to a conservative live/spoof/inconclusive decision."""
    values = np.asarray(scores, dtype=np.float32).reshape(-1)
    if values.shape != (2,) or not np.isfinite(values).all():
        return INCONCLUSIVE
    if (values < 0).any() or (values > 1).any() or not np.isclose(values.sum(), 1, atol=0.02):
        values = np.exp(values - np.max(values))
        values /= values.sum()
    live_score, spoof_score = (float(value) for value in values)
    if live_score >= LIVENESS_LIVE_THRESHOLD:
        return LIVE
    if spoof_score >= LIVENESS_SPOOF_THRESHOLD:
        return SPOOF
    return INCONCLUSIVE


def _box_iou(first, second):
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    intersection = max(0, right - left) * max(0, bottom - top)
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


class LivenessStabilizer:
    def __init__(self):
        self.tracks = []

    def update(self, boxes, verdicts, now):
        self.tracks = [track for track in self.tracks if now - track['last'] <= LIVENESS_MAX_GAP]
        used = set()
        results = []
        for box, verdict in zip(boxes, verdicts):
            best_index, best_iou = None, 0.25
            for index, track in enumerate(self.tracks):
                overlap = _box_iou(box, track['box']) if index not in used else 0.0
                if overlap > best_iou:
                    best_index, best_iou = index, overlap
            if best_index is None:
                track = {
                    'box': box, 'last': now,
                    'history': [], 'state': CHECKING,
                }
                self.tracks.append(track)
                best_index = len(self.tracks) - 1
            else:
                track = self.tracks[best_index]
            used.add(best_index)

            if verdict == SPOOF:
                track['history'] = []
                track['state'] = SPOOF
            else:
                track['history'].append((now, verdict))
                track['history'] = track['history'][-LIVENESS_RESULT_WINDOW:]
                live_times = [stamp for stamp, result in track['history'] if result == LIVE]
                stable_live = (
                    verdict == LIVE
                    and len(live_times) >= LIVENESS_STABLE_FRAMES
                    and now - live_times[0] >= LIVENESS_STABLE_DURATION
                )
                track['state'] = LIVE if stable_live else (
                    CHECKING if verdict == LIVE else INCONCLUSIVE
                )
            track['box'] = box
            track['last'] = now
            results.append(track['state'])
        return results


class FaceBook:
    def __init__(self, detector_path, recognizer_path, db_path, liveness_path=None):
        liveness_path = liveness_path or Path(detector_path).with_name('face_anti_spoof_mn3.onnx')
        for path in (detector_path, recognizer_path):
            if not Path(path).is_file():
                raise FileNotFoundError(f'Missing face model: {Path(path).name}')
        self.detector = cv2.FaceDetectorYN.create(str(detector_path), '', (320, 320), 0.8)
        self.recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), '')
        self.liveness_path = Path(liveness_path)
        self.liveness_net = None
        self.liveness_stabilizer = LivenessStabilizer()
        self.db_path = Path(db_path)
        self.people = {}
        self._load()

    def _load(self):
        try:
            data = json.loads(self.db_path.read_text())
            self.people = {name: [np.array(v, dtype=np.float32).reshape(1, -1) for v in vectors]
                           for name, vectors in data.items()}
        except Exception:
            self.people = {}

    def _save(self):
        data = {name: [v.reshape(-1).tolist() for v in vectors] for name, vectors in self.people.items()}
        self.db_path.write_text(json.dumps(data))

    def roster(self):
        return sorted(self.people)


    def _detect(self, frame):
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(frame)
        return faces if faces is not None else []

    def _embed(self, frame, face):
        return self.recognizer.feature(self.recognizer.alignCrop(frame, face)).copy()

    def enroll(self, name, frame, liveness=None, *, liveness_enabled=True, detected_faces=None):
        faces = self._detect(frame) if detected_faces is None else detected_faces
        if len(faces) == 0:
            return {'ok': False, 'name': name,
                    'message': 'No face detected. Enrollment requires exactly one visible face.'}
        if len(faces) > 1:
            return {'ok': False, 'name': name,
                    'message': 'Multiple faces detected. Enrollment requires exactly one visible face.'}
        if liveness_enabled and liveness != LIVE:
            return {'ok': False, 'name': name,
                    'message': 'A stable live face is required for enrollment.'}
        face = faces[0]
        self.people.setdefault(name, []).append(self._embed(frame, face))
        self.people[name] = self.people[name][-MAX_SAMPLES:]
        self._save()
        return {'ok': True, 'name': name, 'message': f'Saved {name} ({len(self.people[name])} sample(s)).'}

    def forget(self, name):
        existed = self.people.pop(name, None) is not None
        if existed:
            self._save()
        return existed

    def _ensure_liveness_model(self):
        if self.liveness_net is None:
            if not self.liveness_path.is_file():
                raise FileNotFoundError(f'Missing face model: {self.liveness_path.name}')
            self.liveness_net = cv2.dnn.readNetFromONNX(str(self.liveness_path))
        return self.liveness_net

    def _liveness_verdict(self, frame, face):
        height, width = frame.shape[:2]
        x, y, face_width, face_height = (int(value) for value in face[:4])
        pad_x, pad_y = int(face_width * 0.05), int(face_height * 0.025)
        left, top = max(0, x - pad_x), max(0, y - pad_y)
        right = min(width, x + face_width + pad_x)
        bottom = min(height, y + face_height + pad_y)
        crop = frame[top:bottom, left:right]
        if crop.size == 0:
            return INCONCLUSIVE
        rgb = cv2.cvtColor(
            cv2.resize(crop, (128, 128), interpolation=cv2.INTER_CUBIC),
            cv2.COLOR_BGR2RGB,
        ).astype(np.float32)
        mean = np.array((151.2405, 119.5950, 107.8395), dtype=np.float32)
        scale = np.array((63.0105, 56.4570, 55.0035), dtype=np.float32)
        blob = np.transpose((rgb - mean) / scale, (2, 0, 1))[None, ...]
        liveness_net = self._ensure_liveness_model()
        liveness_net.setInput(blob)
        return classify_liveness(liveness_net.forward())

    def check_liveness(self, frame, now=None):
        now = time.monotonic() if now is None else now
        faces = self._detect(frame)
        boxes = [tuple(int(value) for value in face[:4]) for face in faces]
        verdicts = []
        for face in faces:
            try:
                verdicts.append(self._liveness_verdict(frame, face))
            except (cv2.error, ValueError, FloatingPointError, FileNotFoundError) as error:
                print(f'Liveness inference failed closed: {error}', file=sys.stderr)
                verdicts.append(INCONCLUSIVE)
        states = self.liveness_stabilizer.update(boxes, verdicts, now)
        return [
            {'box': box, 'liveness': state, 'face_data': face}
            for box, state, face in zip(boxes, states, faces)
        ]

    def recognize(self, frame, liveness_results=None, liveness_enabled=True):
        if liveness_enabled:
            liveness_results = liveness_results if liveness_results is not None else self.check_liveness(frame)
        else:
            liveness_results = [
                {
                    'box': tuple(int(value) for value in face[:4]),
                    'liveness': DISABLED,
                    'face_data': face,
                }
                for face in self._detect(frame)
            ]

        results = []
        for item in liveness_results:
            face = item['face_data']
            if liveness_enabled and item['liveness'] != LIVE:
                results.append({
                    'box': item['box'], 'name': None, 'score': 0.0,
                    'liveness': item['liveness'], 'face_data': face,
                })
                continue
            embedding = self._embed(frame, face)
            best_name, best_score = None, 0.0
            for name, vectors in self.people.items():
                for reference in vectors:
                    score = self.recognizer.match(embedding, reference, COSINE)
                    if score > best_score:
                        best_name, best_score = name, score
            x, y, w, h = (int(v) for v in face[:4])
            results.append({
                'box': (x, y, w, h),
                'name': best_name if best_score >= COSINE_THRESHOLD else None,
                'score': round(float(best_score), 3),
                'liveness': item['liveness'],
                'face_data': face,
            })
        return results


def recognition_initialization_error(error):
    prefix = 'Missing face model: '
    if isinstance(error, FileNotFoundError):
        message = str(error)
        if message.startswith(prefix):
            basename = Path(message[len(prefix):]).name
            if basename in {
                'face_detection_yunet_2026may.onnx',
                'face_recognition_sface_2021dec.onnx',
            }:
                return f'{prefix}{basename}'
    return f'Face recognition initialization failed ({type(error).__name__})'
