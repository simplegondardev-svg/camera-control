"""Temporal review rules, independent of camera/model code for deterministic tests."""
import math
import uuid
from datetime import datetime, timezone

def centre(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)

def contains(box, point, margin=0):
    x, y = point
    return box[0]-margin <= x <= box[2]+margin and box[1]-margin <= y <= box[3]+margin

def iou(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0

class EventTracker:
    def __init__(self):
        self.items = {}
        self.last_time = None
        self.session = uuid.uuid4().hex[:8]

    def update(self, now, persons, objects, wrists, width, height, uncertain=()):
        if self.last_time is not None and now-self.last_time > 2.5:
            self.items.clear()  # An interruption is not evidence of disappearance.
        self.last_time = now
        margin = min(width, height)*0.045
        events, pickups = [], []
        for tid, obj in objects.items():
            if tid not in self.items:
                matches = [old for old, s in self.items.items() if old not in objects
                           and now-s['last_seen'] < 1.5 and s['label'] == obj['label']
                           and iou(s['box'], obj['box']) > 0.35]
                if len(matches) == 1:
                    self.items[tid] = self.items.pop(matches[0])
        for tid, obj in objects.items():
            s = self.items.setdefault(tid, {
                'state': 'visible', 'owner': None, 'candidate': None, 'near_since': None,
                'away_since': None, 'origin': centre(obj['box']), 'armed': False,
                'alerted': False, 'pickup': None,
            })
            s.update(last_seen=now, label=obj['label'], box=obj['box'])
            owners = {owner for x, y, owner in wrists if owner in persons and contains(obj['box'], (x, y), margin)}
            owner = next(iter(owners)) if len(owners) == 1 else None
            if owner is not None and owner not in uncertain:
                s['away_since'] = None
                if s['candidate'] != owner or s['near_since'] is None:
                    s.update(candidate=owner, near_since=now, origin=centre(obj['box']))
                movement = math.dist(s['origin'], centre(obj['box']))
                if now-s['near_since'] >= 0.6 and movement >= min(width, height)*0.015:
                    if not s['armed'] or s['owner'] != owner:
                        pickups.append(tid)
                    s.update(owner=owner, armed=True, alerted=False, state='in_hand')
                elif not s['armed']:
                    s['state'] = 'near_hand'
            else:
                s.update(candidate=None, near_since=None)
                if s['away_since'] is None:
                    s['away_since'] = now
                if now-s['away_since'] >= 1.0:
                    s.update(state='set_down' if s['armed'] else 'visible', armed=False, owner=None)
            owner_box = persons.get(s['owner'])
            s['at_body'] = bool(owner_box and contains(owner_box, centre(obj['box'])))
            s['last_near'] = owner is not None and owner == s['owner']
            if s['armed']:
                s['state'] = 'in_hand' if owner == s['owner'] else 'visible_away'

        for tid, s in list(self.items.items()):
            gone = now-s['last_seen']
            if gone > 25:
                del self.items[tid]
                continue
            if tid in objects or not s['armed'] or s['alerted']:
                continue
            s.update(near_since=None, candidate=None)
            owner = s['owner']
            body = persons.get(owner)
            at_edge = body and (body[0] < width*.04 or body[2] > width*.96 or body[1] < height*.02 or body[3] > height*.98)
            obstructed = any(pid != owner and contains(box, centre(s['box']), margin) for pid, box in persons.items())
            if not body or at_edge or owner in uncertain or obstructed or not s['at_body'] or not s['last_near']:
                s.update(armed=False, state='uncertain')
                continue
            s['state'] = 'occluded' if gone < 1.5 else 'watching'
            if gone >= 4.0:
                s.update(state='disappeared', alerted=True, armed=False)
                events.append({
                    'id': uuid.uuid4().hex, 'at': datetime.now(timezone.utc).isoformat(),
                    'temporaryPersonId': f'{self.session}-{owner}', 'object': s['label'],
                    'headline': 'Possible concealment - needs human review',
                    'reason': 'A moving item associated with a wrist has been unseen for at least 4 seconds after last being visible at the body.',
                    'trackId': tid, 'pickup': s['pickup'],
                })
        return events, pickups
