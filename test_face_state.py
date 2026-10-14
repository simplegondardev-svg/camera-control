import unittest
from unittest.mock import patch

from face_state import FaceStateWorker, face_state_metrics


class FaceStateWorkerErrorTests(unittest.TestCase):
    def test_error_is_reported_and_cleared_after_successful_inference(self):
        result = [{
            'box': (1, 2, 3, 4),
            'smile': True,
            'frown': False,
            'mouth_open': False,
            'eyes_closed': False,
            'facing': True,
        }]

        class Reader:
            def __init__(self, _model_path):
                self.fail = True

            def read(self, _frame):
                if self.fail:
                    self.fail = False
                    raise RuntimeError('inference failed')
                return result

        worker = FaceStateWorker('unused-model.task')
        with patch('face_state.FaceStateReader', Reader):
            worker._process_frame(object())
            error_status = worker.get_status()
            self.assertEqual(error_status, {'results': [], 'error': 'inference failed'})
            self.assertEqual(face_state_metrics(error_status), {
                'faceStateError': 'inference failed',
                'faceStates': {
                    'smiling': 0,
                    'frowning': 0,
                    'mouthOpen': 0,
                    'eyesClosed': 0,
                    'lookingAway': 0,
                },
            })

            worker._process_frame(object())
            success_status = worker.get_status()
            self.assertEqual(success_status, {'results': result, 'error': None})
            self.assertEqual(face_state_metrics(success_status), {
                'faceStateError': None,
                'faceStates': {
                    'smiling': 1,
                    'frowning': 0,
                    'mouthOpen': 0,
                    'eyesClosed': 0,
                    'lookingAway': 0,
                },
            })

    def test_initialization_error_is_reported(self):
        worker = FaceStateWorker('unused-model.task')
        with patch('face_state.FaceStateReader', side_effect=RuntimeError('model unavailable')):
            worker._process_frame(object())
        self.assertEqual(worker.get_status(), {'results': [], 'error': 'model unavailable'})

    def test_empty_error_message_still_reports_failure(self):
        worker = FaceStateWorker('unused-model.task')
        with patch('face_state.FaceStateReader', side_effect=RuntimeError()):
            worker._process_frame(object())
        self.assertEqual(worker.get_status(), {'results': [], 'error': 'RuntimeError'})


if __name__ == '__main__':
    unittest.main()
