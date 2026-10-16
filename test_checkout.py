import base64
import json
import subprocess
import sys
import time
import unittest
import cv2
import numpy as np
from checkout_tracker import CheckoutTracker
from face_state import FaceStateWorker


def face(score=.7, box=(10,10,80,90), facing=True):
    return {'box':box,'brow_score':score,'facing':facing}


class CheckoutTests(unittest.TestCase):
    def test_sustained_signal_and_continuous_duplicate_suppression(self):
        tracker=CheckoutTracker()
        self.assertEqual(tracker.update([face()],0),[])
        self.assertEqual(tracker.update([face()],.5),[])
        events=tracker.update([face()],1)
        self.assertEqual(len(events),1)
        self.assertEqual(events[0]['durationSeconds'],1)
        for step in range(1,61):
            self.assertEqual(tracker.update([face()],1+step*.5),[])

    def test_neutral_reset_cooldown_and_new_signal(self):
        tracker=CheckoutTracker(cooldown=2)
        for now in (0,.5,1): tracker.update([face()],now)
        tracker.update([face(.1)],1.5)
        tracker.update([face(.1)],2)
        tracker.update([face(.1)],3)
        self.assertEqual(tracker.update([face()],3.5),[])
        self.assertEqual(tracker.update([face()],4),[])
        self.assertEqual(len(tracker.update([face()],4.5)),1)

    def test_short_signal_missing_face_errors_and_camera_gaps_cannot_trigger(self):
        tracker=CheckoutTracker()
        tracker.update([face()],0);tracker.update([], .5)
        self.assertEqual(tracker.update([face()],1),[])
        tracker.update([face(float('nan'))],1.5)
        self.assertEqual(tracker.update([face(facing=False)],2),[])
        tracker.update([face()],3)
        self.assertEqual(tracker.update([face()],10),[])

    def test_faces_are_tracked_separately(self):
        tracker=CheckoutTracker()
        second=face(.1,(150,10,220,90))
        for now in (0,.5):tracker.update([face(),second],now)
        self.assertEqual(len(tracker.update([face(),second],1)),1)

    def test_mouth_frown_is_detected_without_lowered_brows(self):
        tracker=CheckoutTracker(signal='either')
        mouth_face={**face(.05),'mouth_frown_score':.7}
        tracker.update([mouth_face],0);tracker.update([mouth_face],.5)
        event=tracker.update([mouth_face],1)[0]
        self.assertEqual(event['signal'],'mouth')
        self.assertEqual(event['browScore'],.05)
        self.assertEqual(event['frownScore'],.7)
        brows_only=CheckoutTracker(signal='brow')
        for now in (0,.5,1):self.assertEqual(brows_only.update([mouth_face],now),[])

    def test_neutral_face_and_invalid_mouth_scores_do_not_trigger(self):
        tracker=CheckoutTracker(signal='either')
        for now in (0,.5,1):self.assertEqual(tracker.update([{**face(.05),'mouth_frown_score':.04}],now),[])
        for now in (2,2.5,3):self.assertEqual(tracker.update([{**face(.9),'mouth_frown_score':float('nan')}],now),[])

    def test_looking_away_does_not_suppress_the_original_frown_signal(self):
        tracker=CheckoutTracker()
        tracker.update([face(facing=False)],0)
        tracker.update([face(facing=False)],.5)
        self.assertEqual(len(tracker.update([face(facing=False)],1)),1)

    def test_real_landmarker_and_customer_zone_worker_without_identity(self):
        _, jpeg=cv2.imencode('.jpg',np.zeros((320,320,3),np.uint8))
        config={'zone':{'x':.1,'y':.1,'width':.8,'height':.8},'threshold':.3,'sustainSeconds':1,'cooldownSeconds':20,'revision':1}
        data=[{'checkoutConfig':config},{'frame':base64.b64encode(jpeg).decode(),'frameAt':10000}]
        result=subprocess.run([sys.executable,'-u','checkout-worker.py'],input='\n'.join(json.dumps(item) for item in data)+'\n',text=True,capture_output=True,timeout=45)
        self.assertEqual(result.returncode,0,result.stderr)
        messages=[json.loads(line) for line in result.stdout.splitlines()]
        output=next(message for message in messages if message['type']=='frame')
        self.assertIn(output['checkoutRuntime']['state'], ['loading','ready'])
        self.assertEqual(output['checkoutEvents'],[])
        self.assertNotIn('faces',output)
        self.assertEqual(output['checkoutRevision'],1)
        worker=FaceStateWorker('models/face_landmarker.task')
        worker.set_enabled(True)
        worker.submit(np.zeros((320,320,3),np.uint8),10000,1)
        deadline=time.monotonic()+10
        while worker.get_observation()['sequence']==0 and time.monotonic()<deadline:
            time.sleep(.05)
        observed=worker.get_observation()
        worker.set_enabled(False)
        self.assertGreater(observed['sequence'],0)
        self.assertIsNone(observed['error'])
        self.assertEqual(observed['frameAt'],10000)
        self.assertEqual(observed['context'],1)


if __name__=='__main__':unittest.main()
