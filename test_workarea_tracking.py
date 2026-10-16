import base64
import json
from pathlib import Path
import subprocess
import sys
import unittest
import cv2
import numpy as np
from workarea_tracking import StaffMarkerTracker,region_state,visible_feet_region


class WorkAreaTrackingTests(unittest.TestCase):
    def setUp(self):
        self.frame=np.zeros((240,240,3),np.uint8)
        self.persons={1:(20,20,90,170),2:(140,20,210,170)}
        self.frame[20:170,20:90]=(0,0,255)
        self.frame[20:170,140:210]=(255,0,0)
        self.staff=[{'id':'red','sessionId':'session-red','color':'#ff0000'},{'id':'blue','sessionId':'session-blue','color':'#0000ff'}]

    def test_two_staff_color_markers_need_stable_confirmation(self):
        tracker=StaffMarkerTracker()
        first,_=tracker.identify(self.frame,self.persons,self.staff,0)
        self.assertTrue(all(o['state']=='uncertain' for o in first))
        results,_=tracker.identify(self.frame,self.persons,self.staff,1)
        self.assertEqual([r['state'] for r in results],['located','located'])
        self.assertEqual([r['trackId'] for r in results],[1,2])

    def test_duplicate_same_color_and_hidden_marker_are_uncertain(self):
        tracker=StaffMarkerTracker();tracker.identify(self.frame,self.persons,self.staff,0);tracker.identify(self.frame,self.persons,self.staff,1)
        missing=np.zeros_like(self.frame)
        result,_=tracker.identify(missing,self.persons,self.staff,2)
        self.assertTrue(all(r['state']=='uncertain' for r in result))
        self.frame[20:170,140:210]=(0,0,255)
        result,_=tracker.identify(self.frame,self.persons,self.staff,3)
        self.assertEqual(result[0]['state'],'uncertain')

    def test_overlap_and_missing_people_do_not_confirm_outside(self):
        tracker=StaffMarkerTracker();tracker.identify(self.frame,self.persons,self.staff,0);tracker.identify(self.frame,self.persons,self.staff,1)
        result,_=tracker.identify(self.frame,{1:(20,20,160,170),2:(60,20,210,170)},self.staff,2)
        self.assertTrue(all(r['state']!='located' for r in result))
        result,_=tracker.identify(self.frame,{},self.staff,3)
        self.assertTrue(all(r['state']=='not_visible' for r in result))

    def test_floor_region_boundary_and_clipped_feet(self):
        zones=[{'id':'left','name':'Left counter','points':[[0,0],[.5,0],[.5,1],[0,1]]}]
        self.assertEqual(region_state((20,20,90,170),zones,['left'],240,240)[0],'inside')
        self.assertEqual(region_state((140,20,210,170),zones,['left'],240,240)[0],'outside')
        self.assertEqual(region_state((100,20,140,170),zones,['left'],240,240)[0],'uncertain')
        self.assertEqual(region_state((20,20,90,240),zones,['left'],240,240)[0],'uncertain')

    def test_hidden_feet_never_confirm_inside_or_outside(self):
        zones=[{'id':'left','name':'Left','points':[[0,0],[.5,0],[.5,1],[0,1]]}]
        pose=np.zeros((17,3));pose[15]=[35,155,.95];pose[16]=[75,155,.95]
        args=(zones,['left'],240,240)
        self.assertEqual(visible_feet_region((20,20,90,170),pose,*args)[0],'inside')
        for confidence in (0,.3,.69):
            pose[16,2]=confidence
            self.assertEqual(visible_feet_region((20,20,90,170),pose,*args)[0],'uncertain')
        self.assertEqual(visible_feet_region((140,20,210,170),None,*args)[0],'uncertain')
        pose[16]=[75,239,.95]
        self.assertEqual(visible_feet_region((20,20,90,240),pose,*args)[0],'uncertain')
        pose[15]=[35,40,.95];pose[16]=[75,40,.95]
        self.assertEqual(visible_feet_region((20,20,90,170),pose,*args)[0],'uncertain')

    def test_camera_gap_requires_new_color_confirmation(self):
        tracker=StaffMarkerTracker();tracker.identify(self.frame,self.persons,self.staff,0);tracker.identify(self.frame,self.persons,self.staff,1)
        result,_=tracker.identify(self.frame,self.persons,self.staff,10)
        self.assertTrue(all(r['state']=='uncertain' for r in result))

    def test_real_person_model_worker_protocol(self):
        sample=Path('.venv/Lib/site-packages/ultralytics/assets/bus.jpg')
        config={'revision':3,'zones':[],'staff':[],'roles':[{'id':'sales','name':'Sales','color':'#ff0000'}]}
        payloads=[{'workAreaConfig':config},{'frame':base64.b64encode(sample.read_bytes()).decode(),'frameAt':10000}]
        result=subprocess.run([sys.executable,'-u','workarea-worker.py'],input='\n'.join(json.dumps(p) for p in payloads)+'\n',text=True,capture_output=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr)
        frames=[json.loads(line) for line in result.stdout.splitlines() if json.loads(line)['type']=='frame']
        self.assertEqual(len(frames),1)
        self.assertEqual(frames[0]['workRuntime']['state'],'ready')
        self.assertEqual(frames[0]['workRevision'],3)
        self.assertEqual(frames[0]['workObservations'],[])
        self.assertIsInstance(frames[0]['roleObservations'],list)
        self.assertNotIn('faces',frames[0])


if __name__=='__main__':unittest.main()
