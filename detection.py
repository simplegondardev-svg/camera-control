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
from attendance import FaceBook
from generic_objects import GenericObjectDetector

PORTABLE_CLASSES = {
    'backpack', 'umbrella', 'handbag', 'suitcase', 'sports ball', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut',
    'cake', 'mouse', 'remote', 'cell phone', 'book', 'scissors', 'teddy bear',
    'hair drier', 'toothbrush',
}

def emit(payload):
    print(json.dumps(payload), flush=True)

class Watcher:
    def __init__(self, objects, pose):
        self.objects, self.pose = objects, pose
        self.tracker = EventTracker()
        self.presence = PresenceMonitor()
        self.tagger = RoleTagger()
        self.facebook = None
        self.attendance_on = False
        self.pending_enroll = None
        self.generic = GenericObjectDetector()
        self.generic_on = False

    def faces(self):
        if self.facebook is None:
            self.facebook = FaceBook(ROOT / 'models/face_detection_yunet.onnx',
                                     ROOT / 'models/face_recognition_sface.onnx',
                                     ROOT / 'face-db.json')
        return self.facebook

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
        roles = self.tagger.classify(frame, persons)
        scale = max(.55, max(h, w)/1400)
        for label, box, tid in boxes:
            state = self.tracker.items.get(tid) if label != 'person' else None
            color = (80, 220, 140) if label == 'person' else (240, 180, 70)
            caption = f'person #{tid}' if label == 'person' else label
            if label == 'person' and roles.get(tid):
                caption = f"{roles[tid]['name']} #{tid}"
                color = roles[tid]['color']
            if state and state['state'] in ('in_hand', 'near_hand', 'visible_away', 'set_down'):
                caption += ' | ' + state['state'].replace('_', ' ')
                if state['armed']:
                    color = (40, 220, 255)
            x1, y1, x2, y2 = box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, caption, (max(0, x1), max(25, y1-8)), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)
        for gid in generic_ids:
            state = self.tracker.items.get(gid)
            x1, y1, x2, y2 = objects[gid]['box']
            color = (0, 170, 255)
            caption = 'object'
            if state and state['state'] in ('in_hand', 'near_hand', 'visible_away', 'set_down'):
                caption += ' | ' + state['state'].replace('_', ' ')
                if state['armed']:
                    color = (40, 220, 255)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, caption, (max(0, x1), max(25, y1-8)), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2)
        for x, y, _ in wrists:
            cv2.circle(frame, (x, y), 7, (255, 100, 230), -1)
        for group in presence['groups']:
            pts = [(int((persons[p][0]+persons[p][2])/2), int((persons[p][1]+persons[p][3])/2))
                   for p in group if p in persons]
            for other in pts[1:]:
                cv2.line(frame, pts[0], other, (230, 120, 255), 2)
            if pts:
                cv2.putText(frame, f'together x{len(pts)}', (pts[0][0], max(15, pts[0][1]-12)),
                            cv2.FONT_HERSHEY_SIMPLEX, scale, (230, 120, 255), 2)
        enrolled, faces_out = None, []
        if self.pending_enroll is not None:
            name, self.pending_enroll = self.pending_enroll, None
            try:
                enrolled = self.faces().enroll(name, frame)
            except Exception as error:
                enrolled = {'ok': False, 'name': name, 'message': str(error)[:140]}
        if self.attendance_on:
            try:
                faces_out = self.faces().recognize(frame)
            except Exception:
                faces_out = []
            for face in faces_out:
                x, y, fw, fh = face['box']
                known = face['name'] is not None
                fcolor = (90, 230, 90) if known else (160, 160, 160)
                cv2.rectangle(frame, (x, y), (x+fw, y+fh), fcolor, 2)
                cv2.putText(frame, face['name'] or 'Unknown', (x, max(15, y-8)),
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
                'knownFaces': self.facebook.roster() if self.facebook else [],
                'faces': [{'name': f['name'], 'score': f['score']} for f in faces_out],
                'genericOn': self.generic_on, 'genericObjects': len(generic_ids)}

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
            if 'attendance' in data:
                watcher.attendance_on = bool(data['attendance'])
                if watcher.attendance_on:
                    try:
                        watcher.faces()
                    except Exception as error:
                        watcher.attendance_on = False
                        emit({'type': 'log', 'message': str(error)[:150]})
                continue
            if 'enroll' in data:
                watcher.pending_enroll = str(data['enroll'])[:40]
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
