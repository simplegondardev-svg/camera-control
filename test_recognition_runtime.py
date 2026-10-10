import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from attendance import FaceBook, recognition_initialization_error
from detection import Watcher


class RecognitionRuntimeTests(unittest.TestCase):
    def test_missing_model_initialization_reports_basename_only(self):
        with tempfile.TemporaryDirectory() as directory:
            detector = Path(directory) / 'face_detection_yunet_2026may.onnx'
            recognizer = Path(directory) / 'face_recognition_sface_2021dec.onnx'
            with self.assertRaises(FileNotFoundError) as raised:
                FaceBook(detector, recognizer, Path(directory) / 'face-db.json')

        self.assertEqual(
            recognition_initialization_error(raised.exception),
            'Missing face model: face_detection_yunet_2026may.onnx',
        )
        self.assertNotIn(directory, recognition_initialization_error(raised.exception))

    def test_other_initialization_errors_do_not_expose_paths(self):
        error = RuntimeError('failed at C:\\private\\camera\\secret.onnx')
        self.assertEqual(
            recognition_initialization_error(error),
            'Face recognition initialization failed (RuntimeError)',
        )

    def test_worker_preserves_specific_initialization_failure(self):
        watcher = Watcher.__new__(Watcher)
        watcher.facebook = None
        watcher.attendance_on = False
        watcher.recognition_only = False
        watcher.recognition_runtime = {'state': 'disabled'}
        missing = FileNotFoundError(
            'Missing face model: face_detection_yunet_2026may.onnx'
        )

        with patch.object(watcher, 'faces', side_effect=missing):
            result = watcher.configure_attendance(True)

        self.assertEqual(watcher.attendance_on, False)
        self.assertEqual(result, {
            'type': 'recognition_status',
            'recognitionRuntime': {
                'state': 'unavailable',
                'message': 'Missing face model: face_detection_yunet_2026may.onnx',
            },
        })

    def test_ready_and_disabled_states_follow_worker_setting(self):
        watcher = Watcher.__new__(Watcher)
        watcher.facebook = object()
        watcher.attendance_on = False
        watcher.recognition_only = False
        watcher.recognition_runtime = {'state': 'disabled'}

        ready = watcher.configure_attendance(True)
        self.assertTrue(watcher.attendance_on)
        self.assertEqual(ready['recognitionRuntime']['state'], 'ready')

        disabled = watcher.configure_attendance(False)
        self.assertFalse(watcher.attendance_on)
        self.assertEqual(disabled['recognitionRuntime']['state'], 'disabled')


if __name__ == '__main__':
    unittest.main()
