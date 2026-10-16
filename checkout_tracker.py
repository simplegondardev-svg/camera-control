"""Temporary geometric tracks for sustained visible brow lowering. No identity."""
import math


def overlap(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection/union if union > 0 else 0


class CheckoutTracker:
    def __init__(self, sustain=1, threshold=.3, cooldown=20, signal='brow'):
        self.sustain, self.threshold, self.cooldown = sustain, threshold, cooldown
        self.signal = signal
        self.tracks = []
        self.last = None

    def update(self, faces, now):
        if self.last is not None and (now-self.last > 2.5 or now < self.last):
            self.tracks = []
        self.last = now
        self.tracks = [track for track in self.tracks if now-track['last'] <= 2.5]
        used, events = set(), []
        for face in faces:
            box = face['box']
            matches = [(overlap(box, track['box']), i) for i, track in enumerate(self.tracks) if i not in used]
            matches = sorted((pair for pair in matches if pair[0] > .3), reverse=True)
            if len(matches) > 1 and matches[0][0]-matches[1][0] < .15:
                # Overlapping tracks cannot contribute stable evidence.
                for _, i in matches:
                    self.tracks[i]['since'] = None
                    self.tracks[i]['samples'] = 0
                continue
            if matches:
                index = matches[0][1]
                track = self.tracks[index]
                if now-track['last'] > 1.5:
                    track['since'], track['samples'] = None, 0
            else:
                track = {'box': box, 'last': now, 'since': None, 'samples': 0, 'latched': False, 'neutral': None, 'emitted': -1e20}
                self.tracks.append(track)
                index = len(self.tracks)-1
            used.add(index)
            track.update(box=box, last=now)
            brow = face.get('brow_score', 0)
            mouth = face.get('mouth_frown_score', 0)
            if any(not isinstance(value, (float,int)) or not math.isfinite(value) or not 0 <= value <= 1 for value in (brow,mouth)):
                track['since'], track['samples'], track['neutral'] = None, 0, None
                continue
            score = mouth if self.signal == 'mouth' else max(brow, mouth) if self.signal == 'either' else brow
            valid = isinstance(score, (float, int)) and math.isfinite(score) and 0 <= score <= 1
            if not valid:
                track['since'], track['samples'], track['neutral'] = None, 0, None
                continue
            if score < self.threshold:
                track['since'], track['samples'] = None, 0
                if track['neutral'] is None:
                    track['neutral'] = now
                if now-track['neutral'] >= 1 and now-track['emitted'] >= self.cooldown:
                    track['latched'] = False
                continue
            track['neutral'] = None
            if track['latched'] or now-track['emitted'] < self.cooldown:
                continue
            if track['since'] is None:
                track['since'] = now
                track['samples'] = 0
            track['samples'] += 1
            if track['samples'] >= 3 and now-track['since'] >= self.sustain:
                signal = 'brow' if self.signal == 'brow' or (self.signal == 'either' and brow >= mouth) else 'mouth'
                events.append({'startedAt': round(track['since']*1000), 'confirmedAt': round(now*1000), 'durationSeconds': round(now-track['since'], 2), 'browScore': round(brow, 3), 'mouthScore': round(mouth, 3), 'frownScore': round(score, 3), 'signal': signal})
                track['latched'], track['emitted'] = True, now
        for index, track in enumerate(self.tracks):
            if index not in used:
                track['since'], track['samples'] = None, 0
        return events
