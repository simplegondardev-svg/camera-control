"""Conservative temporary identities for simple preview color components."""
import math


class PreviewTracker:
    def __init__(self):self.tracks={};self.next_id=1;self.last=None

    def update(self,objects,now):
        if self.last is not None and (now<self.last or now-self.last>3):self.tracks.clear()
        self.last=now;costs={}
        for i,o in enumerate(objects):
            for tid,t in self.tracks.items():
                distance=math.dist(o['center'],t['object']['center'])
                ratio=o['area']/t['object']['area']
                if o['color']==t['object']['color'] and distance<.12 and .6<ratio<1.65:costs[i,tid]=distance
        current={}
        for i,o in enumerate(objects):
            options=sorted((d,tid) for (index,tid),d in costs.items() if index==i);match=None
            if options and (len(options)==1 or options[1][0]-options[0][0]>.02):
                tid=options[0][1];rivals=sorted((d,index) for (index,t),d in costs.items() if t==tid)
                if rivals[0][1]==i and (len(rivals)==1 or rivals[1][0]-rivals[0][0]>.02):match=tid
            if match is None:tid=self.next_id;self.next_id+=1;since=now;frames=1
            else:tid=match;since=self.tracks[tid]['since'];frames=self.tracks[tid]['frames']+1
            o['trackId']=tid;o['stable']=frames>=2 and now-since>=.4 and not o.get('cropped',False)
            current[tid]={'object':o,'since':since,'frames':frames}
        self.tracks=current;return objects
