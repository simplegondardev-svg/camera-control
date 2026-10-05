"""Foot-traffic and proximity analytics, independent of camera/model code.

Two easy, anonymous features built on the person tracks the worker already
produces:
  * foot traffic  -> people now, peak concurrent, and unique people seen
  * "hanging together" -> people who stay close to each other for a while

This reads only transient tracker IDs and box geometry. No faces, no identity.
It never raises an alert; it reports read-only indicators for a human to read.
"""
import math

# --- Tunable thresholds ------------------------------------------------------
CLOSE_FACTOR = 1.25     # centre distance < this * average box width => "close"
GROUP_SECONDS = 8.0     # must stay close this long before counting as together
INTERRUPTION = 2.5      # a gap longer than this clears stale togetherness timers


class PresenceMonitor:
    def __init__(self):
        self.seen = set()       # every person track id seen this session
        self.peak = 0           # most people visible at once
        self.pairs = {}         # frozenset(id, id) -> time they first got close
        self.last_time = None

    def update(self, now, persons, width, height):
        if self.last_time is not None and now - self.last_time > INTERRUPTION:
            self.pairs.clear()  # a break in the feed is not continued togetherness
        self.last_time = now

        self.seen.update(persons)
        self.peak = max(self.peak, len(persons))

        ids = sorted(persons)
        close_now = set()
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                if self._close(persons[ids[i]], persons[ids[j]]):
                    close_now.add(frozenset((ids[i], ids[j])))

        present = set(ids)
        for pair in list(self.pairs):
            if pair not in close_now or not pair <= present:
                del self.pairs[pair]
        for pair in close_now:
            self.pairs.setdefault(pair, now)

        grouped_pairs = [pair for pair, since in self.pairs.items() if now - since >= GROUP_SECONDS]
        groups = [sorted(group) for group in self._components(grouped_pairs)]
        return {
            'uniquePeople': len(self.seen),
            'peoplePeak': self.peak,
            'groups': groups,
        }

    @staticmethod
    def _close(a, b):
        # Require vertical overlap (roughly the same depth) and centres closer
        # than ~1.25 average body widths. Scaling by box width keeps the test
        # consistent as people appear larger near the camera.
        if min(a[3], b[3]) - max(a[1], b[1]) <= 0:
            return False
        ca = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2)
        cb = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        avg_width = ((a[2] - a[0]) + (b[2] - b[0])) / 2
        return avg_width > 0 and math.dist(ca, cb) < CLOSE_FACTOR * avg_width

    @staticmethod
    def _components(pairs):
        adjacency = {}
        for pair in pairs:
            a, b = tuple(pair)
            adjacency.setdefault(a, set()).add(b)
            adjacency.setdefault(b, set()).add(a)
        seen, groups = set(), []
        for node in adjacency:
            if node in seen:
                continue
            stack, component = [node], set()
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                component.add(current)
                stack.extend(adjacency[current] - seen)
            if len(component) >= 2:
                groups.append(component)
        return groups
