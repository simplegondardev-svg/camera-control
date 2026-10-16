"""Face-only scanning worker; no object or expression models run at the station."""
import base64
import json
import os
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from face_storage import SqliteFaceBook

ROOT = Path(__file__).parent


def emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    book = None
    enabled = False
    recognition_only = False
    liveness_enabled = False
    pending = None
    emit({'type': 'ready'})
    for line in sys.stdin:
        started = time.monotonic()
        try:
            data = json.loads(line)
            if 'attendance' in data:
                enabled = bool(data['attendance'])
                continue
            if 'recognitionOnly' in data:
                recognition_only = bool(data['recognitionOnly'])
                continue
            if 'livenessEnabled' in data:
                liveness_enabled = bool(data['livenessEnabled'])
                continue
            if 'enroll' in data:
                pending = (str(data['enroll']), started)
                continue
            if 'frame' not in data:
                continue
            frame = cv2.imdecode(np.frombuffer(base64.b64decode(data['frame']), np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError('Invalid camera frame')
            faces, enrolled = [], None
            runtime = {'state': 'disabled', 'message': 'Face recognition is disabled.'}
            if enabled or recognition_only or pending:
                try:
                    if book is None:
                        book = SqliteFaceBook(ROOT / 'models/face_detection_yunet_2026may.onnx', ROOT / 'models/face_recognition_sface_2021dec.onnx', Path(os.environ.get('CAMERA_DB_PATH', ROOT / 'attendance.sqlite')))
                    live_results = book.check_liveness(frame, started) if liveness_enabled else None
                    faces = book.recognize(frame, live_results, liveness_enabled=liveness_enabled)
                    runtime = {'state': 'ready', 'message': 'Face scanner ready.'}
                    if pending and not recognition_only:
                        staff_id, since = pending
                        if len(faces) == 1 and faces[0]['staffId'] and faces[0]['staffId'] != staff_id:
                            enrolled = {'ok': False, 'staffId': staff_id, 'message': f"This face is already enrolled for {faces[0]['name']}. Edit that staff profile instead of enrolling a duplicate."}
                            pending = None
                        elif not liveness_enabled:
                            enrolled = book.enroll(staff_id, frame, liveness_enabled=False, detected_faces=[face['face_data'] for face in faces])
                            pending = None
                        elif len(faces) != 1:
                            enrolled = {'ok': False, 'staffId': staff_id, 'message': 'Enrollment needs exactly one visible face.'}
                            pending = None
                        elif faces[0]['liveness'] == 'LIVE':
                            enrolled = book.enroll(staff_id, frame, liveness='LIVE', detected_faces=[faces[0]['face_data']])
                            pending = None
                        elif started - since >= 15:
                            enrolled = {'ok': False, 'staffId': staff_id, 'message': 'No stable live face confirmed. Try enrollment again.'}
                            pending = None
                except Exception as error:
                    print(f'Face scanner error: {error}', file=sys.stderr)
                    runtime = {'state': 'unavailable', 'message': 'Face scanner unavailable. Check the local models and database.'}
                    if pending:
                        enrolled = {'ok': False, 'staffId': pending[0], 'message': 'Face enrollment failed. Check the scanner and try again.'}
                        pending = None
                    faces = []
            for face in faces:
                x, y, width, height = face['box']
                color = (120, 220, 140) if face['name'] else (160, 180, 210)
                cv2.rectangle(frame, (x, y), (x + width, y + height), color, 2)
                cv2.putText(frame, face['name'] or 'Unknown', (max(0, x), max(24, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, .7, color, 2)
            ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                raise ValueError('Cannot encode camera preview')
            emit({'type': 'frame', 'frame': base64.b64encode(jpeg).decode(),
                  'faces': [{key: face[key] for key in ('staffId', 'name', 'score', 'liveness')} for face in faces],
                  'enrolled': enrolled, 'attendanceOn': enabled, 'recognitionRuntime': runtime,
                  'recognitionOnly': recognition_only, 'livenessEnabled': liveness_enabled,
                  'knownFaces': book.roster() if book else [], 'inferenceMs': round((time.monotonic() - started) * 1000)})
        except Exception as error:
            emit({'type': 'frame_error', 'message': str(error)[:180]})


if __name__ == '__main__':
    main()
