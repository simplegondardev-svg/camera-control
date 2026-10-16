import base64
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import cv2
import numpy as np


class StationWorkerTests(unittest.TestCase):
    def test_real_models_sqlite_enrollment_and_worker_frame_protocol(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / 'attendance.sqlite'
            with closing(sqlite3.connect(db_path)) as db, db:
                db.executescript('CREATE TABLE staff(id TEXT PRIMARY KEY,name TEXT,active INTEGER); CREATE TABLE face_embeddings(id INTEGER PRIMARY KEY,staff_id TEXT,vector BLOB,created_at TEXT);')
                db.execute('INSERT INTO staff VALUES (?,?,?)', ('fixture-id', 'Fixture Person', 1))
            _, jpeg = cv2.imencode('.jpg', np.zeros((320, 320, 3), np.uint8))
            payloads = [{'attendance': True}, {'livenessEnabled': False}, {'enroll': 'fixture-id'}, {'frame': base64.b64encode(jpeg).decode()}]
            result = subprocess.run([sys.executable, '-u', 'attendance-worker.py'], input='not-json\n'+'\n'.join(json.dumps(payload) for payload in payloads)+'\n', text=True, capture_output=True, timeout=45, env={**os.environ, 'CAMERA_DB_PATH': str(db_path)})
            self.assertEqual(result.returncode, 0, result.stderr)
            messages = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertTrue(any(message['type']=='frame_error' for message in messages))
            frame = next(message for message in messages if message['type']=='frame')
            self.assertEqual(frame['recognitionRuntime']['state'], 'ready')
            self.assertFalse(frame['enrolled']['ok'])
            self.assertEqual(frame['enrolled']['name'], 'Fixture Person')
            self.assertEqual(frame['faces'], [])
            decoded = cv2.imdecode(np.frombuffer(base64.b64decode(frame['frame']), np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(decoded.shape, (320, 320, 3))
            with closing(sqlite3.connect(db_path)) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM face_embeddings').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
