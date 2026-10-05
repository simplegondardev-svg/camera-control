"""Opt-in face enrollment and recognition for attendance.

Uses OpenCV's built-in YuNet detector and SFace recognizer (no extra Python
dependency). Enrolled face embeddings are stored locally in face-db.json.

This is a NAMED, biometric feature and is separate from the anonymous
concealment pipeline. It only runs when the operator turns it on, and every
enrolled person should have given consent. Camera-only recognition can be wrong;
treat results as an aid, not an authority. There is no liveness check yet, so a
printed photo could fool it.
"""
import json
from pathlib import Path

import cv2
import numpy as np

COSINE = getattr(cv2, 'FaceRecognizerSF_FR_COSINE', 0)
COSINE_THRESHOLD = 0.363   # SFace's recommended same-person cosine threshold
MAX_SAMPLES = 5            # keep a few embeddings per person for robustness


class FaceBook:
    def __init__(self, detector_path, recognizer_path, db_path):
        for path in (detector_path, recognizer_path):
            if not Path(path).is_file():
                raise FileNotFoundError(f'Missing face model: {Path(path).name}')
        self.detector = cv2.FaceDetectorYN.create(str(detector_path), '', (320, 320), 0.8)
        self.recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), '')
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

    def enroll(self, name, frame):
        faces = self._detect(frame)
        if len(faces) == 0:
            return {'ok': False, 'name': name, 'message': 'No face detected. Face the camera and try again.'}
        face = max(faces, key=lambda f: f[2] * f[3])  # largest = closest
        self.people.setdefault(name, []).append(self._embed(frame, face))
        self.people[name] = self.people[name][-MAX_SAMPLES:]
        self._save()
        return {'ok': True, 'name': name, 'message': f'Saved {name} ({len(self.people[name])} sample(s)).'}

    def forget(self, name):
        existed = self.people.pop(name, None) is not None
        if existed:
            self._save()
        return existed

    def recognize(self, frame):
        results = []
        for face in self._detect(frame):
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
            })
        return results
