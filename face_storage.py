"""SQLite face embeddings shared with the attendance station (float32 BLOBs)."""
import sqlite3
from contextlib import contextmanager
import numpy as np
from attendance import FaceBook


class SqliteFaceBook(FaceBook):
    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.db_path, timeout=5)
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _load(self):
        self.people = {}
        self.display_names = {}
        with self._connect() as connection:
            for staff_id, name in connection.execute('SELECT id,name FROM staff WHERE active=1'):
                self.display_names[staff_id] = name
            for staff_id, vector in connection.execute('SELECT f.staff_id,f.vector FROM face_embeddings f JOIN staff s ON s.id=f.staff_id WHERE s.active=1 ORDER BY f.id'):
                embedding = np.frombuffer(vector, dtype='<f4').copy().reshape(1, -1)
                if embedding.shape != (1, 128) or not np.isfinite(embedding).all():
                    raise ValueError('Invalid saved face embedding')
                self.people.setdefault(staff_id, []).append(embedding)

    def _save(self):
        target = self.enroll_target
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            if not connection.execute('SELECT id FROM staff WHERE id=? AND active=1', (target,)).fetchone():
                raise ValueError('Staff member is inactive or unavailable')
            connection.execute('DELETE FROM face_embeddings WHERE staff_id=?', (target,))
            for embedding in self.people[target]:
                connection.execute("INSERT INTO face_embeddings(staff_id,vector,created_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (target, embedding.astype('<f4').tobytes()))

    def enroll(self, name, frame, *args, **kwargs):
        self._load()
        if name not in self.display_names:
            raise ValueError('Choose an active staff member before enrolling')
        self.enroll_target = name
        try:
            result = super().enroll(name, frame, *args, **kwargs)
            result['staffId'] = name
            result['name'] = self.display_names[name]
            if result['ok']:
                result['message'] = f"Saved face for {result['name']} ({len(self.people[name])} samples)."
            return result
        finally:
            self.enroll_target = None

    def recognize(self, frame, *args, **kwargs):
        self._load()
        results = super().recognize(frame, *args, **kwargs)
        for result in results:
            result['staffId'] = result['name']
            result['name'] = self.display_names.get(result['staffId'])
        return results

    def roster(self):
        return sorted(self.display_names[staff_id] for staff_id in self.people)
