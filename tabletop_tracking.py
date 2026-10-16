"""Test-only colored paper tracking. Each separate connected piece is one token."""
import cv2
import numpy as np
from workarea_tracking import marker_ranges


class TabletopTracker:
    def __init__(self):self.tracks={};self.next_id=1;self.last=None

    def observe(self,frame,roles,zones,now):
        if self.last is not None and (now-self.last>3 or now<self.last):self.tracks.clear()
        self.last=now;h,w=frame.shape[:2];hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV);detections=[]
        for role in roles:
            mask=np.zeros((h,w),np.uint8)
            color=role['color'].lower()
            if color=='#000000':mask=cv2.inRange(hsv,np.array([0,0,0]),np.array([179,255,65]))
            elif color=='#ffffff':mask=cv2.inRange(hsv,np.array([0,0,195]),np.array([179,65,255]))
            else:
                for lo,hi in marker_ranges(color):mask=cv2.bitwise_or(mask,cv2.inRange(hsv,lo,hi))
            count,labels,stats,centers=cv2.connectedComponentsWithStats(mask)
            for i in range(1,count):
                x,y,bw,bh,area=map(int,stats[i])
                if area<max(100,h*w*.0005) or area>h*w*.25 or area/(bw*bh)<.55:continue
                detections.append({'roleId':role['id'],'center':centers[i],'area':area,'box':[x,y,x+bw,y+bh]})
        # Match only unambiguous nearby pieces. Missing pieces lose their IDs immediately.
        pairs={}
        for i,d in enumerate(detections):
            for tid,t in self.tracks.items():
                distance=float(np.linalg.norm(d['center']-t['center']))
                if t['roleId']==d['roleId'] and distance<min(w,h)*.15 and .6<d['area']/t['area']<1.65:pairs[(i,tid)]=distance
        current={};results=[]
        for i,d in enumerate(detections):
            choices=sorted((distance,tid) for (index,tid),distance in pairs.items() if index==i)
            match=None
            if choices and (len(choices)==1 or choices[1][0]-choices[0][0]>8):
                tid=choices[0][1]
                rivals=sorted((distance,index) for (index,t),distance in pairs.items() if t==tid)
                if rivals[0][1]==i and (len(rivals)==1 or rivals[1][0]-rivals[0][0]>8):match=tid
            if match is None:tid=self.next_id;self.next_id+=1;since=now;frames=1
            else:tid=match;since=self.tracks[tid]['since'];frames=self.tracks[tid]['frames']+1
            current[tid]={**d,'since':since,'frames':frames}
            x,y=d['center'];box=d['box'];reason='Confirming paper';state='uncertain';zone_ids=[]
            if frames>=2 and now-since>=.4:
                if box[0]<=1 or box[1]<=1 or box[2]>=w-1 or box[3]>=h-1:reason='Paper cropped at image edge'
                else:
                    distances=[(z,cv2.pointPolygonTest(np.asarray(z['points'],np.float32),(float(x/w),float(y/h)),True)) for z in zones]
                    if any(abs(distance)<.015 for _,distance in distances):reason='Paper near region boundary'
                    else:state='confirmed';reason='Paper center';zone_ids=[z['id'] for z,distance in distances if distance>0]
            results.append({'trackId':tid,'roleId':d['roleId'],'state':state,'zoneIds':zone_ids,'reason':reason,'center':[float(x),float(y)],'box':box})
        self.tracks=current
        return results
