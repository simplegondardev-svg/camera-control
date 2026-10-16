import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
import numpy as np
from face_storage import SqliteFaceBook


class FaceStorageTests(unittest.TestCase):
    def test_enrollment_uses_staff_id_and_binary_sqlite_embeddings(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / 'attendance.sqlite'
            with closing(sqlite3.connect(db_path)) as db, db:
                db.executescript('CREATE TABLE staff(id TEXT PRIMARY KEY,name TEXT,active INTEGER); CREATE TABLE face_embeddings(id INTEGER PRIMARY KEY,staff_id TEXT,vector BLOB,created_at TEXT);')
                db.execute('INSERT INTO staff VALUES (?,?,?)', ('staff-id', 'Test Person', 1))
            book = SqliteFaceBook.__new__(SqliteFaceBook)
            book.db_path = db_path
            book._detect = lambda frame: np.array([[1, 1, 10, 10]], dtype=np.float32)
            book._embed = lambda frame, face: np.ones((1,128), np.float32)
            for _ in range(7):
                result = book.enroll('staff-id', np.zeros((20,20,3), np.uint8), liveness_enabled=False)
                self.assertTrue(result['ok'])
                self.assertEqual(result['name'], 'Test Person')
            with closing(sqlite3.connect(db_path)) as db, db:
                rows = db.execute('SELECT vector FROM face_embeddings').fetchall()
                self.assertEqual(len(rows), 5)
                self.assertEqual(len(rows[0][0]), 512)
                db.execute("UPDATE staff SET name='Renamed Person'")
            book._load()
            self.assertEqual(book.roster(), ['Renamed Person'])
            with closing(sqlite3.connect(db_path)) as db, db:
                db.execute('UPDATE staff SET active=0')
            book._load()
            self.assertEqual(book.people, {})
            with self.assertRaises(ValueError):
                book.enroll('staff-id', np.zeros((20,20,3), np.uint8), liveness_enabled=False)


if __name__ == '__main__':
    unittest.main()
