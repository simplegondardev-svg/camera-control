import unittest
from unittest.mock import patch

import numpy as np

from detection import draw_detection_overlays
from event_tracker import EventTracker


class DetectionOverlayTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        rectangle = patch('detection.cv2.rectangle')
        put_text = patch('detection.cv2.putText')
        circle = patch('detection.cv2.circle')
        self.rectangle = rectangle.start()
        self.put_text = put_text.start()
        self.circle = circle.start()
        self.addCleanup(circle.stop)
        self.addCleanup(put_text.stop)
        self.addCleanup(rectangle.stop)

    def test_person_and_supported_object_boxes_keep_labels_and_frame_coordinates(self):
        boxes = [
            ('person', (100, 80, 400, 680), 7),
            ('bottle', (320, 410, 365, 520), 12),
            ('chair', (700, 100, 1100, 650), 20),
        ]
        roles = {7: {'name': 'Staff', 'color': (20, 30, 40)}}

        draw_detection_overlays(self.frame, boxes, roles, {}, {}, set(), [])

        rectangles = [call.args[1:] for call in self.rectangle.call_args_list]
        self.assertEqual(
            rectangles,
            [
                ((100, 80), (400, 680), (20, 30, 40), 2),
                ((320, 410), (365, 520), (240, 180, 70), 2),
            ],
        )
        captions = [call.args[1] for call in self.put_text.call_args_list]
        self.assertEqual(captions, ['Staff #7', 'bottle'])
        self.assertNotIn('chair', captions)

    def test_portable_object_state_label_and_armed_color_are_preserved(self):
        boxes = [('bottle', (30, 40, 90, 150), 4)]
        tracker_items = {
            4: {'state': 'in_hand', 'armed': True},
        }

        draw_detection_overlays(self.frame, boxes, {}, tracker_items, {}, set(), [])

        rectangle = self.rectangle.call_args.args[1:]
        self.assertEqual(
            rectangle,
            ((30, 40), (90, 150), (40, 220, 255), 2),
        )
        self.assertEqual(self.put_text.call_args.args[1], 'bottle | in hand')

    def test_experimental_object_box_and_wrist_landmark_remain_separate_overlays(self):
        objects = {100001: {'label': 'object', 'box': (215, 305, 270, 380)}}
        wrists = [(240, 340, 2)]

        draw_detection_overlays(
            self.frame, [], {}, {}, objects, {100001}, wrists,
        )

        self.assertEqual(
            self.rectangle.call_args.args[1:],
            ((215, 305), (270, 380), (0, 170, 255), 2),
        )
        self.assertEqual(self.put_text.call_args.args[1], 'object')
        self.circle.assert_called_once_with(
            self.frame, (240, 340), 7, (255, 100, 230), -1,
        )

    def test_pixel_space_wrist_association_arms_moving_detected_object(self):
        tracker = EventTracker()
        persons = {2: (100, 50, 500, 700)}

        def obj(x):
            return {'label': 'bottle', 'box': (x, 320, x+50, 390)}

        tracker.update(0.0, persons, {12: obj(220)}, [(245, 350, 2)], 1280, 720)
        tracker.update(0.3, persons, {12: obj(230)}, [(255, 350, 2)], 1280, 720)
        tracker.update(0.6, persons, {12: obj(240)}, [(265, 350, 2)], 1280, 720)

        self.assertTrue(tracker.items[12]['armed'])
        self.assertEqual(tracker.items[12]['state'], 'in_hand')
        self.assertEqual(tracker.items[12]['box'], (240, 320, 290, 390))


if __name__ == '__main__':
    unittest.main()
