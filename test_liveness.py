"""Deterministic tests for fail-closed face liveness gating."""
import unittest
import tempfile
from pathlib import Path

import numpy as np

from attendance import (
    CHECKING,
    DISABLED,
    INCONCLUSIVE,
    LIVE,
    SPOOF,
    FaceBook,
    LivenessStabilizer,
    classify_liveness,
)


class FakeRecognizer:
    def __init__(self, score=0.95):
        self.matches = 0
        self.score = score

    def match(self, embedding, reference, method):
        self.matches += 1
        return self.score


class LivenessTests(unittest.TestCase):
    def test_confident_live_result_is_accepted(self):
        self.assertEqual(classify_liveness([0.97, 0.03]), LIVE)

    def test_confident_spoof_is_rejected(self):
        self.assertEqual(classify_liveness([0.02, 0.98]), SPOOF)

    def test_publisher_decision_boundary_has_conservative_inconclusive_band(self):
        self.assertEqual(classify_liveness([0.60, 0.40]), LIVE)
        self.assertEqual(classify_liveness([0.40, 0.60]), SPOOF)
        self.assertEqual(classify_liveness([0.55, 0.45]), INCONCLUSIVE)

    def test_ambiguous_or_invalid_result_is_inconclusive(self):
        self.assertEqual(classify_liveness([0.55, 0.45]), INCONCLUSIVE)
        self.assertEqual(classify_liveness([np.nan, 0.0]), INCONCLUSIVE)
        self.assertEqual(classify_liveness([0.8]), INCONCLUSIVE)

    def test_live_result_requires_stable_frames_and_resets_after_gap(self):
        gate = LivenessStabilizer()
        box = (10, 10, 100, 120)
        self.assertEqual(gate.update([box], [LIVE], 0.0), [CHECKING])
        self.assertEqual(gate.update([box], [INCONCLUSIVE], 0.5), [INCONCLUSIVE])
        self.assertEqual(gate.update([box], [LIVE], 1.0), [CHECKING])
        self.assertEqual(gate.update([box], [LIVE], 1.5), [LIVE])
        self.assertEqual(gate.update([box], [LIVE], 4.1), [CHECKING])

    def test_spoof_or_inconclusive_breaks_live_stability(self):
        gate = LivenessStabilizer()
        box = (10, 10, 100, 120)
        gate.update([box], [LIVE], 0.0)
        self.assertEqual(gate.update([box], [SPOOF], 0.5), [SPOOF])
        self.assertEqual(gate.update([box], [LIVE], 1.0), [CHECKING])
        self.assertEqual(gate.update([box], [INCONCLUSIVE], 1.5), [INCONCLUSIVE])
        self.assertEqual(gate.update([box], [LIVE], 2.0), [CHECKING])
        self.assertEqual(gate.update([box], [LIVE], 2.5), [LIVE])
        self.assertEqual(gate.update([box], [LIVE], 3.0), [LIVE])

    def test_multiple_faces_stabilize_independently(self):
        gate = LivenessStabilizer()
        boxes = [(10, 10, 100, 120), (200, 10, 100, 120)]
        self.assertEqual(gate.update(boxes, [LIVE, SPOOF], 0.0), [CHECKING, SPOOF])
        self.assertEqual(gate.update(boxes, [LIVE, LIVE], 0.5), [CHECKING, CHECKING])
        self.assertEqual(gate.update(boxes, [LIVE, LIVE], 1.0), [LIVE, CHECKING])
        self.assertEqual(gate.update(boxes, [LIVE, LIVE], 1.5), [LIVE, LIVE])

    def test_sface_runs_only_after_stable_live_and_unknown_stays_unknown(self):
        book = FaceBook.__new__(FaceBook)
        book.people = {'Alice': [np.ones((1, 128), dtype=np.float32)]}
        book.recognizer = FakeRecognizer()
        book._embed = lambda frame, face: np.ones((1, 128), dtype=np.float32)
        frame = np.zeros((160, 160, 3), dtype=np.uint8)
        face_data = np.array([10, 10, 100, 120], dtype=np.float32)

        def recognize(state):
            return book.recognize(frame, [{
                'box': (10, 10, 100, 120), 'liveness': state, 'face_data': face_data,
            }], liveness_enabled=True)[0]

        self.assertIsNone(recognize(CHECKING)['name'])
        self.assertIsNone(recognize(SPOOF)['name'])
        self.assertIsNone(recognize(INCONCLUSIVE)['name'])
        self.assertEqual(book.recognizer.matches, 0)
        result = recognize(LIVE)
        self.assertEqual(result['name'], 'Alice')
        self.assertEqual(book.recognizer.matches, 1)

        book.people.clear()
        result = recognize(LIVE)
        self.assertIsNone(result['name'])
        self.assertEqual(result['liveness'], LIVE)
        self.assertEqual(book.recognizer.matches, 1)

    def test_enrollment_requires_live_result_when_liveness_is_enabled(self):
        book = FaceBook.__new__(FaceBook)
        book.people = {}
        book._detect = lambda frame: [np.array([10, 10, 100, 120], dtype=np.float32)]
        book._embed = lambda frame, face: self.fail('Rejected enrollment must not create an embedding')

        result = book.enroll('Alice', np.zeros((160, 160, 3), dtype=np.uint8), liveness=DISABLED)

        self.assertFalse(result['ok'])
        self.assertIn('stable live face is required', result['message'])
        self.assertEqual(book.people, {})

    def test_enrollment_liveness_off_reuses_exactly_one_detected_face(self):
        with tempfile.TemporaryDirectory(prefix='camera-enroll-test-') as folder:
            book = FaceBook.__new__(FaceBook)
            book.db_path = Path(folder) / 'db.json'
            book.people = {}
            face_data = np.array([10, 10, 100, 120], dtype=np.float32)
            book._detect = lambda frame: self.fail('Provided detection should be reused')
            book._embed = lambda frame, face: np.ones((1, 128), dtype=np.float32)

            result = book.enroll(
                'Alice',
                np.zeros((160, 160, 3), dtype=np.uint8),
                liveness_enabled=False,
                detected_faces=[face_data],
            )

            self.assertTrue(result['ok'])
            self.assertEqual(book.roster(), ['Alice'])
            self.assertEqual(len(book.people['Alice']), 1)

    def test_enrollment_liveness_off_rejects_zero_or_multiple_faces(self):
        book = FaceBook.__new__(FaceBook)
        book.people = {}
        book._embed = lambda frame, face: self.fail('Invalid face count must not create an embedding')
        frame = np.zeros((160, 160, 3), dtype=np.uint8)

        no_face = book.enroll('Alice', frame, liveness_enabled=False, detected_faces=[])
        multiple_faces = book.enroll(
            'Alice',
            frame,
            liveness_enabled=False,
            detected_faces=[np.array([0, 0, 10, 10]), np.array([20, 20, 30, 30])],
        )

        self.assertFalse(no_face['ok'])
        self.assertIn('No face detected', no_face['message'])
        self.assertFalse(multiple_faces['ok'])
        self.assertIn('Multiple faces detected', multiple_faces['message'])
        self.assertEqual(book.people, {})

    def test_liveness_disabled_runs_yunet_and_sface_without_liveness_inference(self):
        book = FaceBook.__new__(FaceBook)
        book.people = {'Alice': [np.ones((1, 128), dtype=np.float32)]}
        book.recognizer = FakeRecognizer()
        face_data = np.array([10, 10, 100, 120], dtype=np.float32)
        book._detect = lambda frame: [face_data]
        book._embed = lambda frame, face: np.ones((1, 128), dtype=np.float32)
        book.check_liveness = lambda *args, **kwargs: self.fail('Liveness inference must be skipped')

        result = book.recognize(np.zeros((160, 160, 3), dtype=np.uint8), liveness_enabled=False)[0]

        self.assertEqual(result['name'], 'Alice')
        self.assertEqual(result['liveness'], DISABLED)
        self.assertEqual(result['score'], 0.95)
        self.assertEqual(book.recognizer.matches, 1)

    def test_liveness_disabled_still_keeps_below_threshold_face_unknown(self):
        book = FaceBook.__new__(FaceBook)
        book.people = {'Alice': [np.ones((1, 128), dtype=np.float32)]}
        book.recognizer = FakeRecognizer(score=0.2)
        face_data = np.array([10, 10, 100, 120], dtype=np.float32)
        book._detect = lambda frame: [face_data]
        book._embed = lambda frame, face: np.ones((1, 128), dtype=np.float32)
        book.check_liveness = lambda *args, **kwargs: self.fail('Liveness inference must be skipped')

        result = book.recognize(np.zeros((160, 160, 3), dtype=np.uint8), liveness_enabled=False)[0]

        self.assertIsNone(result['name'])
        self.assertEqual(result['liveness'], DISABLED)
        self.assertEqual(result['score'], 0.2)
        self.assertEqual(book.recognizer.matches, 1)


if __name__ == '__main__':
    unittest.main()
