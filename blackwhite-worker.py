"""Simple full-frame pink/white blob preview, with no regions or staff rules."""
import base64
import json
import sys
import cv2
import numpy as np
from preview_tracking import PreviewTracker


def detect(frame):
    hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV);height,width=frame.shape[:2];objects=[]
    for name,low,high,color in [('Pink',(140,65,65),(175,255,255),(180,60,255)),('White',(0,0,195),(179,65,255),(255,190,30))]:
        mask=cv2.inRange(hsv,np.array(low),np.array(high))
        count,labels,stats,centers=cv2.connectedComponentsWithStats(mask)
        for i in range(1,count):
            x,y,w,h,area=map(int,stats[i]);fraction=area/(width*height)
            if area<max(100,width*height*.0007) or fraction>.6:continue
            if fraction>.15 and (x==0 or y==0 or x+w>=width or y+h>=height):continue
            objects.append({'color':name.lower(),'box':[x,y,x+w,y+h],'center':[float(centers[i][0]/width),float(centers[i][1]/height)],'area':area,'cropped':x<=1 or y<=1 or x+w>=width-1 or y+h>=height-1})
            cv2.rectangle(frame,(x,y),(x+w-1,y+h-1),color,2)
            cv2.putText(frame,name,(x,max(17,y-6)),cv2.FONT_HERSHEY_SIMPLEX,.6,color,2)
    return objects


def main():
    tracker=PreviewTracker();revision=None
    print(json.dumps({'type':'ready'}),flush=True)
    for line in sys.stdin:
        try:
            data=json.loads(line)
            if 'frame' not in data:continue
            frame=cv2.imdecode(np.frombuffer(base64.b64decode(data['frame']),np.uint8),cv2.IMREAD_COLOR)
            if frame is None:raise ValueError('Invalid camera frame')
            if revision!=data.get('previewRevision'):tracker=PreviewTracker();revision=data.get('previewRevision')
            objects=tracker.update(detect(frame),data.get('frameAt',0)/1000)
            for obj in objects:
                if not obj['stable']:
                    x,y,_,_=obj['box'];reason='cropped' if obj['cropped'] else 'confirming'
                    cv2.putText(frame,reason,(x,max(32,y+18)),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,180,255),2)
            _,jpeg=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,80])
            print(json.dumps({'type':'frame','frame':base64.b64encode(jpeg).decode(),'blackWhiteObjects':objects,'previewFrameAt':data.get('frameAt'),'previewRevision':revision}),flush=True)
        except Exception as error:print(json.dumps({'type':'frame_error','message':str(error)[:150]}),flush=True)


if __name__=='__main__':main()
