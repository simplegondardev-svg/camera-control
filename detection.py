"""Local model worker. Node owns durable evidence; this process owns tracking."""
import base64
import contextlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
os.environ['YOLO_CONFIG_DIR'] = str(ROOT / '.yolo')
os.environ['YOLO_OFFLINE'] = 'true'
import cv2
import numpy as np
import torch
from ultralytics import YOLO
from event_tracker import EventTracker, iou
from presence import PresenceMonitor
from roles import RoleTagger
from attendance import FaceBook, recognition_initialization_error
from generic_objects import GenericObjectDetector
from face_state import FaceStateWorker, face_state_metrics, label_for

PORTABLE_CLASSES = {
    'backpack', 'umbrella', 'handbag', 'suitcase', 'sports ball', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut',
    'cake', 'mouse', 'remote', 'cell phone', 'book', 'scissors', 'teddy bear',
    'hair drier', 'toothbrush',
}


def emit(payload):
    print(json.dumps(payload), flush=True)


def _enrollment_failure_message(error, liveness_enabled):
    detail = str(error)[:100]
    if liveness_enabled:
        return f'Liveness check unavailable; enrollment blocked. {detail}'
    return f'Face enrollment failed. {detail}'


def draw_detection_overlays(frame, boxes, roles, tracker_items, objects, generic_ids, wrists):
    height, width = frame.shape[:2]
    scale = max(.55, max(height, width)/1400)
    for label, box, tid in boxes:
        if label != 'person' and label not in PORTABLE_CLASSES:
            continue
        state = tracker_items.get(tid) if label != 'person' else None
        color = (80, 220, 140) if label == 'person' else (240, 180, 70)
        caption = f'person #{tid}' if label == 'person' else label
        if label == 'person' and roles.get(tid):
            caption = f"{roles[tid]['name']} #{tid}"
            color = roles[tid]['color']
        if state and state['state'] in ('in_hand', 'near_hand', 'visible_away', 'set_down'):
            caption += ' | ' + state['state'].replace('_', ' ')
            if state['armed']:
                color = (40, 220, 255)
        if state and state['state'] == 'disappeared':
            color = (40, 40, 240)
        x1, y1, x2, y2 = box
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, caption, (max(0, x1), max(25, y1-8)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)

    for gid in generic_ids:
        state = tracker_items.get(gid)
        x1, y1, x2, y2 = objects[gid]['box']
        color = (0, 170, 255)
        caption = 'object'
        if state and state['state'] in ('in_hand', 'near_hand', 'visible_away', 'set_down'):
            caption += ' | ' + state['state'].replace('_', ' ')
            if state['armed']:
                color = (40, 220, 255)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, caption, (max(0, x1), max(25, y1-8)),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)

    for x, y, _ in wrists:
        cv2.circle(frame, (x, y), 7, (255, 100, 230), -1)


class Watcher:
    def __init__(self, objects, pose):
        self.objects, self.pose = objects, pose
        self.tracker = EventTracker()
        self.presence = PresenceMonitor()
        self.tagger = RoleTagger()
        self.facebook = None
        self.attendance_on = False
        self.recognition_only = False
        self.recognition_runtime = {
            'state': 'disabled',
            'message': 'Face recognition is disabled in settings.',
        }
        self.liveness_enabled = False
        self.pending_enroll = None
        self.generic = GenericObjectDetector()
        self.generic_on = False
        self.face_state_on = False
        self.fsw = FaceStateWorker(ROOT / 'models/face_landmarker.task')

    def faces(self):
        if self.facebook is None:
            self.facebook = FaceBook(ROOT / 'models/face_detection_yunet_2026may.onnx',
                                     ROOT / 'models/face_recognition_sface_2021dec.onnx',
                                     ROOT / 'face-db.json')
        return self.facebook

    def configure_attendance(self, enabled):
        if enabled and self.recognition_only:
            self.attendance_on = False
            return {
                'type': 'recognition_status',
                'recognitionRuntime': dict(self.recognition_runtime),
            }
        if not enabled:
            self.attendance_on = False
            if self.recognition_only:
                self.recognition_runtime = {
                    'state': 'ready',
                    'message': 'Recognition-only test mode is ready.',
                }
            else:
                self.recognition_runtime = {
                    'state': 'disabled',
                    'message': 'Face recognition is disabled in settings.',
                }
        else:
            try:
                self.faces()
            except Exception as error:
                self.attendance_on = False
                self.recognition_runtime = {
                    'state': 'unavailable',
                    'message': recognition_initialization_error(error),
                }
            else:
                self.attendance_on = True
                self.recognition_runtime = {
                    'state': 'ready',
                    'message': 'Face recognition is ready.',
                }
        return {
            'type': 'recognition_status',
            'recognitionRuntime': dict(self.recognition_runtime),
        }

    def configure_recognition_only(self, enabled):
        if not enabled:
            self.recognition_only = False
            return {
                'type': 'recognition_status',
                'recognitionRuntime': dict(self.recognition_runtime),
            }
        if self.attendance_on or self.liveness_enabled:
            self.recognition_only = False
            self.recognition_runtime = {
                'state': 'unavailable',
                'message': 'Recognition-only mode requires attendance and liveness to be disabled.',
            }
        else:
            try:
                self.faces()
            except Exception as error:
                self.recognition_only = False
                self.recognition_runtime = {
                    'state': 'unavailable',
                    'message': recognition_initialization_error(error),
                }
            else:
                self.recognition_only = True
                self.recognition_runtime = {
                    'state': 'ready',
                    'message': 'Recognition-only test mode is ready.',
                }
        return {
            'type': 'recognition_status',
            'recognitionRuntime': dict(self.recognition_runtime),
        }

    def _recognize_only(self, frame):
        if not self.recognition_only:
            return []
        return self.faces().recognize(frame, liveness_enabled=False)

    def _enrollment_failed(self, error):
        name = self.pending_enroll[0] if self.pending_enroll is not None else ''
        if not self.liveness_enabled:
            self.pending_enroll = None
        return {
            'ok': False,
            'name': name,
            'message': _enrollment_failure_message(error, self.liveness_enabled),
        }

    def process(self, frame, now):
        _, raw = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        with contextlib.redirect_stdout(sys.stderr):
            tracked = self.objects.track(frame, persist=True, imgsz=416, conf=0.35,
                                         device='cpu', verbose=False, tracker='bytetrack.yaml')[0]
            posed = self.pose.predict(frame, imgsz=416, conf=0.4, device='cpu', verbose=False)[0]
        persons, objects, boxes = {}, {}, []
        for box in tracked.boxes:
            label = tracked.names[int(box.cls.item())]
            coords = tuple(map(int, box.xyxy[0].tolist()))
            tid = int(box.id.item()) if box.id is not None else None
            boxes.append((label, coords, tid))
            if label == 'person' and tid is not None:
                persons[tid] = coords
            elif label in PORTABLE_CLASSES and tid is not None:
                objects[tid] = {'label': label, 'box': coords}
        wrists, reliable = [], set()
        if posed.keypoints is not None:
            for pb, person in zip(posed.boxes.xyxy.tolist(), posed.keypoints.data.tolist()):
                candidates = sorted(((iou(pb, b), pid) for pid, b in persons.items()), reverse=True)
                owner = candidates[0][1] if candidates and candidates[0][0] > .4 else None
                if len(candidates) > 1 and candidates[0][0]-candidates[1][0] < .15:
                    owner = None
                if owner is not None and person[5][2] > .5 and person[6][2] > .5:
                    if abs(person[5][0]-person[6][0]) > (pb[2]-pb[0])*.18:
                        reliable.add(owner)
                for index in (9, 10):
                    x, y, confidence = person[index]
                    if confidence >= .5:
                        wrists.append((int(x), int(y), owner))
        h, w = frame.shape[:2]
        generic_ids = set()
        if self.generic_on:
            for gid, blob in self.generic.update(frame, wrists, now).items():
                if all(iou(blob['box'], o['box']) < 0.3 for o in objects.values()):
                    objects[gid] = blob
                    generic_ids.add(gid)
        events, pickups = self.tracker.update(now, persons, objects, wrists, w, h, set(persons)-reliable)
        for tid in pickups:
            self.tracker.items[tid]['pickup'] = base64.b64encode(raw).decode()
        presence = self.presence.update(now, persons, w, h)
        face_source = frame.copy() if self.attendance_on or self.pending_enroll is not None or self.face_state_on else frame
        if self.face_state_on:
            self.fsw.submit(face_source)   # background thread; never blocks this loop
            face_state_status = self.fsw.get_status()
            face_states = face_state_status['results']
        else:
            face_states = []
            face_state_status = {'results': face_states, 'error': None}
        roles = self.tagger.classify(frame, persons)
        scale = max(.55, max(h, w)/1400)
        draw_detection_overlays(
            frame, boxes, roles, self.tracker.items, objects, generic_ids, wrists,
        )
        for st in face_states:
            x1, y1, x2, y2 = st['box']
            fscolor = (90, 200, 230)
            cv2.rectangle(frame, (x1, y1), (x2, y2), fscolor, 1)
            cv2.putText(frame, label_for(st), (max(0, x1), max(15, y1-6)),
                        cv2.FONT_HERSHEY_SIMPLEX, scale, fscolor, 2)
        for group in presence['groups']:
            pts = [(int((persons[p][0]+persons[p][2])/2), int((persons[p][1]+persons[p][3])/2))
                   for p in group if p in persons]
            for other in pts[1:]:
                cv2.line(frame, pts[0], other, (230, 120, 255), 2)
            if pts:
                cv2.putText(frame, f'together x{len(pts)}', (pts[0][0], max(15, pts[0][1]-12)),
                            cv2.FONT_HERSHEY_SIMPLEX, scale, (230, 120, 255), 2)
        enrolled, faces_out = None, []
        liveness_results = []
        if self.attendance_on or self.pending_enroll is not None or self.recognition_only:
            try:
                face_book = self.faces()
                if self.liveness_enabled:
                    liveness_results = face_book.check_liveness(face_source, now)
                if self.attendance_on:
                    faces_out = face_book.recognize(
                        face_source,
                        liveness_results if self.liveness_enabled else None,
                        liveness_enabled=self.liveness_enabled,
                    )
                elif self.recognition_only:
                    faces_out = self._recognize_only(face_source)
                if self.pending_enroll is not None:
                    try:
                        name, started = self.pending_enroll
                        if not self.liveness_enabled:
                            detected_faces = (
                                [item['face_data'] for item in faces_out]
                                if self.attendance_on else None
                            )
                            enrolled = face_book.enroll(
                                name,
                                face_source,
                                liveness_enabled=False,
                                detected_faces=detected_faces,
                            )
                            self.pending_enroll = None
                        else:
                            if not self.attendance_on:
                                faces_out = [
                                    {'box': item['box'], 'name': None, 'score': 0.0,
                                     'liveness': item['liveness'], 'face_data': item['face_data']}
                                    for item in liveness_results
                                ]
                            if not liveness_results:
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'No face detected. Enrollment requires exactly one visible face.'}
                                self.pending_enroll = None
                            elif len(liveness_results) > 1:
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'Multiple faces detected. Enrollment requires exactly one visible face.'}
                                self.pending_enroll = None
                            elif liveness_results[0]['liveness'] == 'LIVE':
                                enrolled = face_book.enroll(
                                    name, face_source, liveness=liveness_results[0]['liveness'])
                                self.pending_enroll = None
                            elif now - started >= 15:
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'Enrollment timed out; no stable live face was confirmed.'}
                                self.pending_enroll = None
                            elif any(item['liveness'] == 'SPOOF / REJECTED' for item in liveness_results):
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'Liveness rejected; enrollment was not saved.'}
                            elif any(item['liveness'] == 'INCONCLUSIVE' for item in liveness_results):
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'Liveness inconclusive; enrollment is waiting for a stable live face.'}
                            else:
                                enrolled = {'ok': False, 'name': name,
                                            'message': 'Checking liveness; hold still facing the camera.'}
                    except Exception as error:
                        print(f'Face verification failed closed: {error}', file=sys.stderr)
                        enrolled = self._enrollment_failed(error)
            except Exception as error:
                print(f'Face verification failed closed: {error}', file=sys.stderr)
                if self.pending_enroll is not None:
                    enrolled = self._enrollment_failed(error)
                else:
                    message = (
                        f'Liveness check unavailable; attendance blocked. {str(error)[:100]}'
                        if self.liveness_enabled else
                        f'Face processing failed. {str(error)[:100]}'
                    )
                    enrolled = {'ok': False, 'name': '', 'message': message}
                faces_out = []
        for face in faces_out:
            x, y, fw, fh = face['box']
            known_live = face['liveness'] == 'LIVE' and face['name'] is not None
            fcolor = (90, 230, 90) if known_live else (160, 160, 160)
            caption = face['name'] or face['liveness'].replace(' / ', '/').title()
            cv2.rectangle(frame, (x, y), (x+fw, y+fh), fcolor, 2)
            cv2.putText(frame, caption, (x, max(15, y-8)),
                        cv2.FONT_HERSHEY_SIMPLEX, scale, fcolor, 2)
        ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            raise ValueError('Cannot encode preview')
        held = [s['label'] for s in self.tracker.items.values() if s['state'] == 'in_hand']
        return {'frame': base64.b64encode(encoded).decode(), 'people': len(persons),
                'objects': sum(label != 'person' for label, _, _ in boxes), 'wrists': len(wrists),
                'inHand': len(held), 'nearby': sorted(set(held)), 'events': events,
                'peoplePeak': presence['peoplePeak'], 'uniquePeople': presence['uniquePeople'],
                'groups': presence['groups'], 'together': sum(len(g) for g in presence['groups']),
                'roleCounts': {r['name']: sum(v['name'] == r['name'] for v in roles.values())
                               for r in self.tagger.roles},
                'attendanceOn': self.attendance_on, 'enrolled': enrolled,
                'recognitionOnly': self.recognition_only,
                'recognitionRuntime': dict(self.recognition_runtime),
                'livenessEnabled': self.liveness_enabled,
                'knownFaces': self.facebook.roster() if self.facebook else [],
                'faces': [{'name': f['name'], 'score': f['score'], 'liveness': f['liveness']}
                          for f in faces_out],
                'genericOn': self.generic_on, 'genericObjects': len(generic_ids),
                'faceStateOn': self.face_state_on,
                **face_state_metrics(face_state_status)}

def main():
    torch.set_num_threads(4)
    for name in ('yolo11n.pt', 'yolo11n-pose.pt'):
        if not (ROOT / 'models' / name).is_file():
            raise FileNotFoundError(f'Missing local model: {name}')
    with contextlib.redirect_stdout(sys.stderr):
        watcher = Watcher(YOLO(ROOT / 'models/yolo11n.pt'), YOLO(ROOT / 'models/yolo11n-pose.pt'))
    emit({'type': 'ready'})
    for line in sys.stdin:
        started = time.monotonic()
        try:
            data = json.loads(line)
            if 'roles' in data:
                watcher.tagger.set_roles(data['roles'])
                continue
            if 'generic' in data:
                watcher.generic_on = bool(data['generic'])
                continue
            if 'faceState' in data:
                watcher.face_state_on = bool(data['faceState'])
                watcher.fsw.set_enabled(watcher.face_state_on)
                continue
            if 'attendance' in data:
                emit(watcher.configure_attendance(bool(data['attendance'])))
                continue
            if 'recognitionOnly' in data:
                emit(watcher.configure_recognition_only(bool(data['recognitionOnly'])))
                continue
            if 'livenessEnabled' in data:
                watcher.liveness_enabled = bool(data['livenessEnabled'])
                continue
            if 'enroll' in data:
                if watcher.recognition_only:
                    emit({'type': 'enrollment_rejected',
                          'message': 'Enrollment is disabled in recognition-only mode.'})
                    continue
                watcher.pending_enroll = (str(data['enroll'])[:40], time.monotonic())
                continue
            frame = cv2.imdecode(np.frombuffer(base64.b64decode(data['frame']), np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError('Invalid video frame')
            result = watcher.process(frame, time.monotonic())
            emit({**result, 'type': 'frame', 'inferenceMs': round((time.monotonic()-started)*1000)})
        except Exception as error:
            emit({'type': 'frame_error', 'message': str(error)[:200]})

if __name__ == '__main__':
    main()
