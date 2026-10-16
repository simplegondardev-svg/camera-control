"""Color marker association and floor-region checks. No facial identification."""
import cv2
import numpy as np
from roles import _hex_to_bgr


def marker_ranges(color):
    h,s,v=map(int,cv2.cvtColor(np.uint8([[_hex_to_bgr(color)]]),cv2.COLOR_BGR2HSV)[0,0])
    spans=[(h-6,h+6)]
    if h<6:spans=[(0,h+6),(180+h-6,179)]
    elif h>173:spans=[(h-6,179),(0,h+6-180)]
    return [(np.array([lo,max(80,s-60),max(60,v-90)]),np.array([hi,255,255])) for lo,hi in spans]


def iou(a,b):
    inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
    return inter/union if union>0 else 0


def region_state(box,zones,allowed,width,height,ground_point=None):
    x=(box[0]+box[2])/2/width;y=box[3]/height
    if ground_point is not None:x,y=ground_point[0]/width,ground_point[1]/height
    if box[3]>=height*.98:return 'uncertain','Feet not fully visible'
    inside=[];near=False
    for zone in zones:
        points=np.array(zone['points'],np.float32)
        distance=cv2.pointPolygonTest(points,(x,y),True)
        if abs(distance)<.015:near=True
        if distance>=0:inside.append(zone)
    if any(z['id'] in allowed for z in inside):return ('uncertain' if near else 'inside'),', '.join(z['name'] for z in inside if z['id'] in allowed)
    if near:return 'uncertain','Near region boundary'
    return 'outside',', '.join(z['name'] for z in inside) or 'Outside mapped regions'


def visible_feet_region(box,keypoints,zones,allowed,width,height):
    """Require both confident ankle landmarks; never fall back to box bottom."""
    if keypoints is None or len(keypoints)<17:
        return 'uncertain','Feet not confirmed visible'
    ankles=np.asarray(keypoints,dtype=float)[[15,16]]
    if not np.isfinite(ankles).all() or np.any(ankles[:,2]<.7):
        return 'uncertain','Feet hidden or low confidence'
    for x,y,_ in ankles:
        if not (width*.01<x<width*.99 and height*.01<y<height*.98):
            return 'uncertain','Feet cropped at camera edge'
        if not (box[0]<=x<=box[2] and box[1]+.55*(box[3]-box[1])<=y<=box[3]):
            return 'uncertain','Foot position unreliable'
    point=ankles[:,:2].mean(axis=0)
    return region_state(box,zones,allowed,width,height,point)


class StaffMarkerTracker:
    def __init__(self):self.candidates={};self.bound={};self.last=None

    def identify(self,frame,persons,staff,now):
        if self.last is not None and (now-self.last>3 or now<self.last):self.candidates.clear();self.bound.clear()
        self.last=now
        height,width=frame.shape[:2];hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
        found={s['id']:[] for s in staff};uncertain=set();labels={}
        for tid,box in persons.items():
            x1,y1,x2,y2=box;w,h=x2-x1,y2-y1
            left,right=max(0,int(x1+w*.1)),min(width,int(x2-w*.1));top,bottom=max(0,int(y1+h*.12)),min(height,int(y1+h*.65))
            crop=hsv[top:bottom,left:right]
            scores=[]
            if crop.size:
                for member in staff:
                    mask=np.zeros(crop.shape[:2],np.uint8)
                    for lo,hi in marker_ranges(member['color']):mask=cv2.bitwise_or(mask,cv2.inRange(crop,lo,hi))
                    pixels=cv2.countNonZero(mask)
                    if pixels>=60 and pixels/crop.shape[0]/crop.shape[1]>=.01:scores.append((pixels,member['id']))
            scores.sort(reverse=True)
            overlaps=any(other!=tid and iou(box,b)>.2 for other,b in persons.items())
            if not scores or overlaps or (len(scores)>1 and scores[0][0]<scores[1][0]*2):
                uncertain.update(sid for _,sid in scores)
                if tid in self.bound:uncertain.add(self.bound[tid])
                self.candidates.pop(tid,None);continue
            sid=scores[0][1];found[sid].append(tid)
            candidate=self.candidates.get(tid)
            if not candidate or candidate['id']!=sid:candidate={'id':sid,'since':now,'frames':0};self.candidates[tid]=candidate
            candidate['frames']+=1
            if candidate['frames']>=2 and now-candidate['since']>=.8:self.bound[tid]=sid;labels[tid]=sid
            else:uncertain.add(sid)
        for tid in list(self.candidates):
            if tid not in persons:self.candidates.pop(tid,None);self.bound.pop(tid,None)
        results=[]
        for member in staff:
            ids=found[member['id']]
            if member['id'] in uncertain or len(ids)>1:state='uncertain';tid=None
            elif len(ids)==1 and labels.get(ids[0])==member['id']:state='located';tid=ids[0]
            else:state='not_visible';tid=None
            results.append({'staffId':member['id'],'sessionId':member['sessionId'],'state':state,'trackId':tid})
        return results,labels
