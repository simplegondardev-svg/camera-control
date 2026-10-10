import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock

import numpy as np

from attendance import COSINE, DISABLED, FaceBook
from detection import Watcher, _enrollment_failure_message


class FakeRecognizer:
    def match(self, embedding, reference, metric):
        if metric != COSINE:
            raise AssertionError('Recognition-only mode must use cosine matching.')
        return float(embedding[0, 0])


class RecognitionOnlyTests(unittest.TestCase):
    def test_enrollment_errors_are_not_mislabeled_as_liveness_when_disabled(self):
        error = ValueError('detector failed')

        self.assertEqual(
            _enrollment_failure_message(error, False),
            'Face enrollment failed. detector failed',
        )
        self.assertEqual(
            _enrollment_failure_message(error, True),
            'Liveness check unavailable; enrollment blocked. detector failed',
        )

    def test_failed_enrollment_without_liveness_clears_pending_request(self):
        watcher = self.make_watcher(None)
        watcher.pending_enroll = ('Alice', 1.0)

        result = watcher._enrollment_failed(ValueError('detector failed'))

        self.assertFalse(result['ok'])
        self.assertEqual(result['name'], 'Alice')
        self.assertEqual(result['message'], 'Face enrollment failed. detector failed')
        self.assertIsNone(watcher.pending_enroll)

    def test_failed_enrollment_with_liveness_preserves_existing_retry_policy(self):
        watcher = self.make_watcher(None)
        watcher.pending_enroll = ('Alice', 1.0)
        watcher.liveness_enabled = True

        result = watcher._enrollment_failed(ValueError('liveness unavailable'))

        self.assertFalse(result['ok'])
        self.assertEqual(
            result['message'],
            'Liveness check unavailable; enrollment blocked. liveness unavailable',
        )
        self.assertEqual(watcher.pending_enroll, ('Alice', 1.0))

    def make_watcher(self, face_book):
        watcher = Watcher.__new__(Watcher)
        watcher.facebook = face_book
        watcher.attendance_on = False
        watcher.liveness_enabled = False
        watcher.recognition_only = False
        watcher.recognition_runtime = {
            'state': 'disabled',
            'message': 'Face recognition is disabled in settings.',
        }
        return watcher

    def test_known_and_unknown_face_results_without_liveness_or_attendance(self):
        root = Path(__file__).parent
        with TemporaryDirectory() as temporary:
            face_book = FaceBook(
                root / 'models/face_detection_yunet_2026may.onnx',
                root / 'models/face_recognition_sface_2021dec.onnx',
                Path(temporary) / 'face-db.json',
            )
            face_book.recognizer = FakeRecognizer()
            face_book.people = {
                'Authorized test identity': [np.array([[0.9]], dtype=np.float32)]
            }
            faces = [
                np.array([10, 20, 30, 40, 1.0], dtype=np.float32),
                np.array([50, 20, 30, 40, 1.0], dtype=np.float32),
            ]
            face_book._detect = Mock(return_value=faces)
            face_book.check_liveness = Mock(
                side_effect=AssertionError('Recognition-only mode must not run liveness.'))
            face_book._embed = Mock(side_effect=[
                np.array([[0.9]], dtype=np.float32),
                np.array([[0.1]], dtype=np.float32),
            ])
            watcher = self.make_watcher(face_book)

            status = watcher.configure_recognition_only(True)
            results = watcher._recognize_only(np.zeros((80, 100, 3), dtype=np.uint8))

            self.assertEqual(status['recognitionRuntime']['state'], 'ready')
            self.assertTrue(watcher.recognition_only)
            self.assertFalse(watcher.attendance_on)
            self.assertFalse(watcher.liveness_enabled)
            self.assertEqual([result['name'] for result in results],
                             ['Authorized test identity', None])
            self.assertEqual([result['liveness'] for result in results],
                             [DISABLED, DISABLED])
            self.assertEqual(face_book._detect.call_count, 1)
            face_book.check_liveness.assert_not_called()
            self.assertFalse((Path(temporary) / 'face-db.json').exists())

    def test_attendance_cannot_be_enabled_after_recognition_only_starts(self):
        face_book = Mock()
        watcher = self.make_watcher(face_book)
        watcher.recognition_only = True
        watcher.recognition_runtime = {'state': 'ready', 'message': 'Ready.'}

        status = watcher.configure_attendance(True)

        self.assertFalse(watcher.attendance_on)
        self.assertEqual(status['recognitionRuntime']['state'], 'ready')
        face_book.assert_not_called()

    def test_initialization_failure_does_not_report_ready(self):
        watcher = self.make_watcher(None)
        watcher.faces = Mock(side_effect=FileNotFoundError(
            'Missing face model: face_detection_yunet_2026may.onnx'))

        status = watcher.configure_recognition_only(True)

        self.assertFalse(watcher.recognition_only)
        self.assertEqual(status['recognitionRuntime']['state'], 'unavailable')
        self.assertEqual(
            status['recognitionRuntime']['message'],
            'Missing face model: face_detection_yunet_2026may.onnx',
        )


if __name__ == '__main__':
    unittest.main()
