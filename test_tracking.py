import unittest
from event_tracker import EventTracker

class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.tracker = EventTracker()
        self.persons = {1: (200, 100, 700, 850)}

    def step(self, t, x=None, wrists=True, persons=None, uncertain=(), tid=10):
        objects = {} if x is None else {tid: {'label': 'bottle', 'box': (x, 400, x+40, 480)}}
        points = [(x+20, 440, 1)] if x is not None and wrists else []
        return self.tracker.update(t, self.persons if persons is None else persons, objects, points, 1000, 1000, uncertain)[0]

    def pickup(self):
        self.step(0, 300)
        self.step(.4, 315)
        self.step(.8, 340)
        self.assertTrue(self.tracker.items[10]['armed'])

    def missing(self, start=1.3, **kwargs):
        events = []
        for i in range(10):
            events += self.step(start+i*.5, **kwargs)
        return events

    def test_sustained_disappearance_alerts_once(self):
        self.pickup()
        self.assertEqual(len(self.missing()), 1)
        self.assertEqual(self.missing(6.3), [])

    def test_set_down_clears_held_state(self):
        self.pickup()
        for t in [1.2, 1.7, 2.3]:
            self.step(t, 340, wrists=False)
        self.assertFalse(self.tracker.items[10]['armed'])
        self.assertEqual(self.missing(2.8), [])

    def test_stationary_object_near_wrist_is_not_pickup(self):
        for t in [0, .5, 1, 1.5, 2]: self.step(t, 300)
        self.assertFalse(self.tracker.items[10]['armed'])
        self.assertEqual(self.missing(2.5), [])

    def test_brief_occlusion_and_reappearance(self):
        self.pickup()
        self.assertEqual(self.step(1.3), [])
        self.assertEqual(self.step(1.8, 340), [])
        self.assertEqual(self.step(2.3, 345), [])

    def test_leaving_frame_cancels_review(self):
        self.pickup()
        self.step(1.3, persons={})
        self.assertEqual(self.missing(1.8), [])

    def test_other_person_obstruction_cancels_review(self):
        self.pickup()
        self.step(1.3, persons={**self.persons, 2: (300, 100, 800, 850)})
        self.assertEqual(self.missing(1.8), [])

    def test_turn_or_uncertain_pose_cancels_review(self):
        self.pickup()
        self.step(1.3, uncertain={1})
        self.assertEqual(self.missing(1.8), [])

    def test_camera_gap_does_not_create_alert(self):
        self.pickup()
        self.assertEqual(self.step(10), [])
        self.assertEqual(self.tracker.items, {})

    def test_short_object_id_switch_does_not_create_old_alert(self):
        self.pickup()
        self.step(1.2, 342, tid=11)
        self.assertNotIn(10, self.tracker.items)
        self.assertIn(11, self.tracker.items)

    def test_unknown_wrist_owner_cannot_arm_item(self):
        for i in range(5):
            self.tracker.update(i*.5, self.persons, {10: {'label': 'bottle', 'box': (300+i*20,400,340+i*20,480)}},
                                [(320+i*20,440,None)],1000,1000)
        self.assertFalse(self.tracker.items[10]['armed'])

if __name__ == '__main__': unittest.main()
