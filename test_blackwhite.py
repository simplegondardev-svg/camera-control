import base64
import json
import subprocess
import sys
import unittest
import cv2
import numpy as np
from preview_tracking import PreviewTracker


class BlackWhiteTests(unittest.TestCase):
    def test_piece_identity_requires_stability_and_resets_on_gap(self):
        tracker=PreviewTracker()
        def pieces(x=.2):return [{'color':'pink','center':[x,.4],'area':400}]
        first=tracker.update(pieces(),0)[0];self.assertFalse(first['stable'])
        moved=tracker.update(pieces(.21),1)[0];self.assertTrue(moved['stable']);self.assertEqual(first['trackId'],moved['trackId'])
        tracker.update([],2);returned=tracker.update(pieces(),3)[0];self.assertNotEqual(first['trackId'],returned['trackId']);self.assertFalse(returned['stable'])
        after_gap=tracker.update(pieces(),10)[0];self.assertFalse(after_gap['stable'])

    def test_full_frame_without_roles_regions_or_people(self):
        frame=np.full((240,320,3),125,np.uint8)
        frame[40:80,30:70]=(180,70,245);frame[120:160,180:220]=240
        frame[140:180,40:80]=20  # A dark shadow must not count as pink.
        _,jpeg=cv2.imencode('.jpg',frame)
        request=json.dumps({'frame':base64.b64encode(jpeg).decode()})+'\n'
        result=subprocess.run([sys.executable,'-u','blackwhite-worker.py'],input=request,text=True,capture_output=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr)
        messages=[json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(messages[0]['type'],'ready');self.assertEqual(messages[1]['type'],'frame')
        objects=messages[1]['blackWhiteObjects'];self.assertEqual(sorted(o['color'] for o in objects),['pink','white'])
        self.assertNotIn('workObservations',messages[1]);self.assertTrue(messages[1]['frame'])


if __name__=='__main__':unittest.main()
