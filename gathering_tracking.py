"""Role-color counting by temporary person tracks; no named identification."""
import cv2
import numpy as np
from workarea_tracking import marker_ranges,iou,visible_feet_region


class RoleRegionTracker:
    def __init__(self):self.candidates={};self.last=None

    def observe(self,frame,persons,poses,roles,zones,now):
        if self.last is not None and (now-self.last>3 or now<self.last):self.candidates.clear()
        self.last=now
        for tid in list(self.candidates):
            if tid not in persons:self.candidates.pop(tid)
        hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV);height,width=frame.shape[:2];results=[]
        for tid,box in persons.items():
            x1,y1,x2,y2=box;w,h=x2-x1,y2-y1
            crop=hsv[max(0,int(y1+h*.12)):min(height,int(y1+h*.65)),max(0,int(x1+w*.1)):min(width,int(x2-w*.1))]
            scores=[]
            if crop.size:
                for role in roles:
                    if role['color'].lower() in ('#000000','#ffffff'):continue
                    mask=np.zeros(crop.shape[:2],np.uint8)
                    for lo,hi in marker_ranges(role['color']):mask=cv2.bitwise_or(mask,cv2.inRange(crop,lo,hi))
                    pixels=cv2.countNonZero(mask)
                    if pixels>=60 and pixels/crop.shape[0]/crop.shape[1]>=.01:scores.append((pixels,role['id']))
            scores.sort(reverse=True)
            if not scores or (len(scores)>1 and scores[0][0]<scores[1][0]*2) or any(other!=tid and iou(box,b)>.2 for other,b in persons.items()):
                self.candidates.pop(tid,None);continue
            role_id=scores[0][1];candidate=self.candidates.get(tid)
            if not candidate or candidate['roleId']!=role_id:candidate={'roleId':role_id,'since':now,'frames':0};self.candidates[tid]=candidate
            candidate['frames']+=1
            obs={'trackId':tid,'roleId':role_id,'state':'uncertain','zoneIds':[],'reason':'Confirming role marker'}
            if candidate['frames']>=2 and now-candidate['since']>=.8:
                state,reason=visible_feet_region(box,poses.get(tid),zones,[z['id'] for z in zones],width,height)
                obs['reason']=reason
                if state!='uncertain':
                    obs['state']='confirmed'
                    point=np.asarray(poses[tid])[[15,16],:2].mean(axis=0)/[width,height]
                    obs['zoneIds']=[z['id'] for z in zones if cv2.pointPolygonTest(np.asarray(z['points'],np.float32),tuple(map(float,point)),False)>0]
            results.append(obs)
        return results
