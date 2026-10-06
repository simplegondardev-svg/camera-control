"""New analytics and attendance checks. Uses synthetic pixels/embeddings only."""
import tempfile
import unittest
from pathlib import Path
import cv2
import numpy as np
from presence import PresenceMonitor
from roles import RoleTagger
from attendance import FaceBook

class ExtrasTests(unittest.TestCase):
    def test_traffic_counts_and_peak(self):
        p = PresenceMonitor()
        a = p.update(0, {1:(0,0,100,200),2:(300,0,400,200)},500,500)
        self.assertEqual((a['uniquePeople'],a['peoplePeak']), (2,2))
        a = p.update(1, {2:(300,0,400,200)},500,500)
        self.assertEqual((a['uniquePeople'],a['peoplePeak']), (2,2))

    def test_groups_require_duration_and_clear_on_separation(self):
        p = PresenceMonitor()
        close = {1:(100,0,200,200),2:(190,0,290,200)}
        for t in range(8): self.assertEqual(p.update(t,close,500,500)['groups'], [])
        self.assertEqual(p.update(8,close,500,500)['groups'], [[1,2]])
        self.assertEqual(p.update(9,{1:close[1],2:(350,0,450,200)},500,500)['groups'], [])

    def test_group_camera_gap_resets_timer(self):
        p = PresenceMonitor()
        close = {1:(100,0,200,200),2:(190,0,290,200)}
        p.update(0,close,500,500)
        self.assertEqual(p.update(10,close,500,500)['groups'], [])

    def test_roles_detect_synthetic_tag_and_ignore_empty_frame(self):
        tagger = RoleTagger()
        tagger.set_roles([{'name':'Cashier','color':'#ff0000'}])
        frame = np.zeros((200,200,3),np.uint8)
        self.assertEqual(tagger.classify(frame,{1:(0,0,200,200)}), {})
        frame[50:75,50:75] = (0,0,255)
        self.assertEqual(tagger.classify(frame,{1:(0,0,200,200)})[1]['name'], 'Cashier')

    def test_roles_ignore_invalid_configuration(self):
        tagger = RoleTagger()
        tagger.set_roles([{'name':'','color':'#ff0000'},{'name':'Bad','color':'#gggggg'}])
        self.assertEqual(tagger.roles, [])

    def test_real_face_models_load_and_blank_frame_has_no_face(self):
        with tempfile.TemporaryDirectory(prefix='camera-face-test-') as folder:
            book = FaceBook('models/face_detection_yunet.onnx','models/face_recognition_sface.onnx',Path(folder)/'db.json')
            frame = np.zeros((320,320,3),np.uint8)
            self.assertEqual(book.recognize(frame), [])
            self.assertFalse(book.enroll('Synthetic test',frame)['ok'])
            self.assertEqual(book.roster(), [])
            self.assertIsNone(book.liveness_net)
            book._ensure_liveness_model().setInput(np.zeros((1,3,128,128),np.float32))
            self.assertEqual(book.liveness_net.forward().shape, (1,2))

    def test_liveness_disabled_enrollment_does_not_require_anti_spoof_model(self):
        with tempfile.TemporaryDirectory(prefix='camera-face-test-') as folder:
            missing_liveness = Path(folder) / 'missing-anti-spoof.onnx'
            book = FaceBook(
                'models/face_detection_yunet.onnx',
                'models/face_recognition_sface.onnx',
                Path(folder) / 'db.json',
                liveness_path=missing_liveness,
            )
            face = np.array([10,20,30,40], dtype=np.float32)
            book._detect = lambda frame: [face]
            book._embed = lambda frame, detected_face: np.ones((1,128), np.float32)

            result = book.enroll(
                'Fixture',
                np.zeros((160,160,3),np.uint8),
                liveness_enabled=False,
            )

            self.assertTrue(result['ok'])
            self.assertEqual(book.roster(), ['Fixture'])
            self.assertIsNone(book.liveness_net)

    def test_synthetic_embeddings_persist_forget_and_limit_samples(self):
        # Deliberately bypass real face capture: vectors are fabricated, not biometrics.
        with tempfile.TemporaryDirectory(prefix='camera-face-test-') as folder:
            book = FaceBook.__new__(FaceBook)
            book.db_path = Path(folder)/'db.json'
            book.people = {}
            book._detect = lambda frame: [np.array([0,0,20,20])]
            book._embed = lambda frame,face: np.ones((1,128),np.float32)
            self.assertFalse(book.enroll('Fixture',None)['ok'])
            self.assertFalse(book.enroll('Fixture',None,liveness='DISABLED')['ok'])
            for _ in range(7): self.assertTrue(book.enroll('Fixture',None,liveness='LIVE')['ok'])
            self.assertEqual(len(book.people['Fixture']),5)
            book.people = {}; book._load()
            self.assertEqual(book.roster(), ['Fixture'])
            self.assertTrue(book.forget('Fixture'))
            book._load(); self.assertEqual(book.roster(), [])

    def test_multiple_faces_are_rejected_during_enrollment(self):
        with tempfile.TemporaryDirectory(prefix='camera-face-test-') as folder:
            book = FaceBook.__new__(FaceBook)
            book.db_path = Path(folder)/'db.json'; book.people = {}
            book._detect = lambda frame: [np.array([0,0,20,20]), np.array([50,0,60,60])]
            embedded = []
            def embed(frame,face):
                embedded.append(face.tolist()); return np.ones((1,128),np.float32)
            book._embed = embed
            result = book.enroll('Requested name',None,liveness='LIVE')
            self.assertFalse(result['ok'])
            self.assertIn('Multiple faces detected', result['message'])
            self.assertEqual(embedded, [])
            self.assertEqual(book.roster(), [])

    def test_enrollment_requires_exactly_one_face(self):
        with tempfile.TemporaryDirectory(prefix='camera-face-test-') as folder:
            book = FaceBook.__new__(FaceBook)
            book.db_path = Path(folder)/'db.json'; book.people = {}
            embedded = []
            book._embed = lambda frame, face: embedded.append(face.tolist()) or np.ones((1,128),np.float32)

            book._detect = lambda frame: []
            no_face = book.enroll('Fixture',None,liveness='LIVE')
            self.assertFalse(no_face['ok'])
            self.assertIn('No face detected', no_face['message'])

            only_face = np.array([10,20,30,40])
            book._detect = lambda frame: [only_face]
            one_face = book.enroll('Fixture',None,liveness='LIVE')
            self.assertTrue(one_face['ok'])
            self.assertEqual(embedded, [only_face.tolist()])

            book._detect = lambda frame: [only_face, np.array([50,60,70,80])]
            multiple_faces = book.enroll('Another fixture',None,liveness='LIVE')
            self.assertFalse(multiple_faces['ok'])
            self.assertIn('Multiple faces detected', multiple_faces['message'])
            self.assertEqual(len(embedded), 1)
            self.assertEqual(book.roster(), ['Fixture'])

if __name__ == '__main__': unittest.main()
