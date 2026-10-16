import unittest
import numpy as np
from gathering_tracking import RoleRegionTracker


class GatheringTrackingTests(unittest.TestCase):
    def setUp(self):
        self.frame=np.zeros((240,320,3),np.uint8)
        self.persons={1:(10,10,90,180),2:(115,10,195,180),3:(220,10,300,180)}
        for box in self.persons.values():
            x,y,x2,y2=box;self.frame[y:y2,x:x2]=(0,0,255)
        self.roles=[{'id':'sales','color':'#ff0000','name':'Sales'}]
        self.zones=[{'id':'floor','name':'Floor','points':[[0,0],[1,0],[1,1],[0,1]]}]
        self.poses={}
        for tid,(x,y,x2,y2) in self.persons.items():
            pose=np.zeros((17,3));pose[15]=[x+20,170,.95];pose[16]=[x2-20,170,.95];self.poses[tid]=pose

    def observe(self,tracker,now,persons=None):return tracker.observe(self.frame,self.persons if persons is None else persons,self.poses,self.roles,self.zones,now)

    def test_same_role_multiple_people_count_separately(self):
        tracker=RoleRegionTracker();self.assertTrue(all(o['state']=='uncertain' for o in self.observe(tracker,0)))
        obs=self.observe(tracker,1);self.assertEqual(len(obs),3);self.assertTrue(all(o['state']=='confirmed' and o['zoneIds']==['floor'] for o in obs))

    def test_hidden_ankle_boundary_and_camera_gap_cannot_confirm(self):
        tracker=RoleRegionTracker();self.observe(tracker,0)
        self.poses[1][15,2]=.1;self.poses[2][15,1]=239
        obs=self.observe(tracker,1);self.assertEqual([o['state'] for o in obs],['uncertain','uncertain','confirmed'])
        self.assertTrue(all(o['state']=='uncertain' for o in self.observe(tracker,10)))

    def test_overlap_or_unreadable_marker_excluded(self):
        tracker=RoleRegionTracker();self.observe(tracker,0)
        self.frame[:]=0;self.assertEqual(self.observe(tracker,1),[])
        self.frame[:]=(0,0,255)
        self.assertEqual(self.observe(tracker,2,{1:(10,10,150,180),2:(50,10,195,180)}),[])


if __name__=='__main__':unittest.main()
