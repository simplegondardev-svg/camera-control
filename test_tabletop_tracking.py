import base64
import json
import subprocess
import sys
import unittest
import cv2
import numpy as np
from tabletop_tracking import TabletopTracker


class TabletopTests(unittest.TestCase):
    def setUp(self):
        self.roles=[{'id':'sales','name':'Sales','color':'#ff0000'},{'id':'cashier','name':'Cashier','color':'#0000ff'}]
        self.zones=[{'id':'left','name':'Left','points':[[0,0],[.65,0],[.65,1],[0,1]]}]
        self.frame=np.full((240,320,3),240,np.uint8)
        for x in [20,85,150]:self.frame[80:105,x:x+20]=(0,0,255)
        self.frame[150:175,230:255]=(255,0,0)

    def test_separate_papers_same_role_and_centers(self):
        tracker=TabletopTracker();tracker.observe(self.frame,self.roles,self.zones,0)
        obs=tracker.observe(self.frame,self.roles,self.zones,1)
        self.assertEqual(len(obs),4);self.assertTrue(all(o['state']=='confirmed' for o in obs))
        self.assertEqual(sum(o['zoneIds']==['left'] for o in obs),3)
        moved=self.frame.copy();moved[80:105,20:40]=240;moved[80:105,30:50]=(0,0,255)
        updated=tracker.observe(moved,self.roles,self.zones,2)
        self.assertEqual([o['trackId'] for o in obs],[o['trackId'] for o in updated])

    def test_removal_merge_edges_and_boundary_reset_confirmation(self):
        tracker=TabletopTracker();tracker.observe(self.frame,self.roles,self.zones,0);before=tracker.observe(self.frame,self.roles,self.zones,1)
        blank=np.full_like(self.frame,240);self.assertEqual(tracker.observe(blank,self.roles,self.zones,2),[])
        returned=tracker.observe(self.frame,self.roles,self.zones,3)
        self.assertTrue(all(o['state']=='uncertain' for o in returned));self.assertFalse(set(o['trackId'] for o in before)&set(o['trackId'] for o in returned))
        edge=blank.copy();edge[80:110,0:20]=(0,0,255);edge[80:110,198:218]=(255,0,0)
        tracker=TabletopTracker();tracker.observe(edge,self.roles,self.zones,0)
        self.assertTrue(all(o['state']=='uncertain' for o in tracker.observe(edge,self.roles,self.zones,1)))
        touching=blank.copy();touching[80:110,30:90]=(0,0,255)
        self.assertEqual(len(TabletopTracker().observe(touching,self.roles,self.zones,0)),1)

    def test_nearby_separate_stationary_papers_keep_identity(self):
        frame=np.full_like(self.frame,240)
        for x in (30,55,80):frame[80:100,x:x+20]=(0,0,255)
        tracker=TabletopTracker();first=tracker.observe(frame,self.roles,self.zones,0);second=tracker.observe(frame,self.roles,self.zones,1)
        self.assertEqual(len(second),3);self.assertEqual([o['trackId'] for o in first],[o['trackId'] for o in second]);self.assertTrue(all(o['state']=='confirmed' for o in second))

    def test_black_plastic_and_white_paper_on_midgray(self):
        roles=[{'id':'black','color':'#000000'},{'id':'white','color':'#ffffff'}]
        frame=np.full_like(self.frame,125)
        frame[70:100,30:60]=20;frame[70:100,90:120]=35;frame[130:160,150:180]=235
        tracker=TabletopTracker();tracker.observe(frame,roles,self.zones,0)
        obs=tracker.observe(frame,roles,self.zones,1)
        self.assertEqual([o['roleId'] for o in obs],['black','black','white']);self.assertTrue(all(o['state']=='confirmed' for o in obs))
        self.assertEqual(TabletopTracker().observe(np.full_like(frame,125),roles,self.zones,0),[])

    def test_worker_paper_protocol_without_people(self):
        _,jpeg=cv2.imencode('.jpg',self.frame)
        config={'revision':9,'inputMode':'tabletop','roles':self.roles,'zones':self.zones,'staff':[]}
        messages=[{'workAreaConfig':config}]+[{'frame':base64.b64encode(jpeg).decode(),'frameAt':at} for at in (10000,11000)]
        result=subprocess.run([sys.executable,'-u','workarea-worker.py'],input='\n'.join(json.dumps(m) for m in messages)+'\n',text=True,capture_output=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr)
        frames=[json.loads(line) for line in result.stdout.splitlines() if json.loads(line)['type']=='frame']
        self.assertEqual(len(frames),2,result.stdout)
        self.assertEqual(frames[-1]['workInputMode'],'tabletop');self.assertEqual(frames[-1]['workObservations'],[])
        self.assertEqual(len(frames[-1]['roleObservations']),4)
        self.assertTrue(all(o['state']=='confirmed' for o in frames[-1]['roleObservations']))


if __name__=='__main__':unittest.main()
