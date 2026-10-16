"""Multi-person color-marker work area worker, without face recognition."""
import base64
import contextlib
import json
import sys
import os
import time
from pathlib import Path
os.environ['YOLO_OFFLINE']='true'
os.environ['YOLO_CONFIG_DIR']=str(Path(__file__).parent/'.yolo')
import cv2
import numpy as np
from ultralytics import YOLO
import torch
from workarea_tracking import StaffMarkerTracker,visible_feet_region
from gathering_tracking import RoleRegionTracker
from tabletop_tracking import TabletopTracker


def emit(data):print(json.dumps(data),flush=True)


def main():
    torch.set_num_threads(4)
    model_path=Path(__file__).parent/'models/yolo11n-pose.pt'
    model=None
    config={'revision':0,'zones':[],'staff':[],'roles':[]};signature='';markers=StaffMarkerTracker();role_tracker=RoleRegionTracker();papers=TabletopTracker()
    emit({'type':'ready'})
    for line in sys.stdin:
        try:
            data=json.loads(line)
            if 'workAreaConfig' in data:
                next_config=data['workAreaConfig'];next_signature=json.dumps(next_config,sort_keys=True)
                if signature!=next_signature:markers=StaffMarkerTracker();role_tracker=RoleRegionTracker();papers=TabletopTracker();signature=next_signature
                config=next_config;continue
            if 'frame' not in data:continue
            frame=cv2.imdecode(np.frombuffer(base64.b64decode(data['frame']),np.uint8),cv2.IMREAD_COLOR)
            if frame is None:raise ValueError('Invalid camera frame')
            height,width=frame.shape[:2]
            if config.get('inputMode')=='tabletop':
                tokens=papers.observe(frame,config.get('roles',[]),config['zones'],data['frameAt']/1000)
                for zone in config['zones']:
                    polygon=np.array([(int(x*width),int(y*height)) for x,y in zone['points']],np.int32)
                    cv2.polylines(frame,[polygon],True,(120,210,160),2)
                    cv2.putText(frame,zone['name'],tuple(polygon[0]),cv2.FONT_HERSHEY_SIMPLEX,.55,(120,210,160),2)
                for token in tokens:
                    x,y=map(int,token['center']);x1,y1,x2,y2=token['box'];color=(80,220,100) if token['state']=='confirmed' else (0,170,255)
                    role=next(r for r in config['roles'] if r['id']==token['roleId'])
                    cv2.rectangle(frame,(x1,y1),(x2,y2),color,2);cv2.circle(frame,(x,y),5,color,-1)
                    cv2.putText(frame,f"Paper {token['trackId']} / {role['name']}",(x1,max(40,y1-7)),cv2.FONT_HERSHEY_SIMPLEX,.5,color,1)
                cv2.putText(frame,'TABLETOP TEST - PAPER CENTERS',(12,25),cv2.FONT_HERSHEY_SIMPLEX,.65,(0,170,255),2)
                _,jpeg=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,80])
                emit({'type':'frame','frame':base64.b64encode(jpeg).decode(),'workInputMode':'tabletop','workObservations':[],'roleObservations':tokens,'workFrameAt':data['frameAt'],'workRevision':config['revision'],'workRuntime':{'state':'ready','message':f"TABLETOP TEST: {len(tokens)} colored paper pieces; staff tracking paused"}})
                continue
            if model is None:
                if not model_path.is_file():raise FileNotFoundError('Missing local pose model: yolo11n-pose.pt')
                with contextlib.redirect_stdout(sys.stderr):model=YOLO(model_path)
            with contextlib.redirect_stdout(sys.stderr):result=model.track(frame,persist=True,classes=[0],imgsz=416,conf=.4,device='cpu',verbose=False,tracker='bytetrack.yaml')[0]
            persons={int(box.id.item()):tuple(map(int,box.xyxy[0].tolist())) for box in result.boxes if box.id is not None}
            poses={int(box.id.item()):result.keypoints.data[i].cpu().numpy() for i,box in enumerate(result.boxes) if box.id is not None} if result.keypoints is not None else {}
            observations,labels=markers.identify(frame,persons,config['staff'],data['frameAt']/1000)
            role_observations=role_tracker.observe(frame,persons,poses,config.get('roles',[]),config['zones'],data['frameAt']/1000)
            for obs in observations:
                member=next(s for s in config['staff'] if s['id']==obs['staffId'])
                if obs['state']=='located':
                    tid=obs['trackId']
                    obs['state'],obs['region']=visible_feet_region(persons[tid],poses.get(tid),config['zones'],member['zoneIds'],width,height)
                    if obs['state'] in ('inside','outside'):
                        for x,y,_ in poses[tid][[15,16]]:cv2.circle(frame,(int(x),int(y)),5,(80,230,100),-1)
            for zone in config['zones']:
                polygon=np.array([(int(x*width),int(y*height)) for x,y in zone['points']],np.int32)
                cv2.polylines(frame,[polygon],True,(120,210,160),2)
                cv2.putText(frame,zone['name'],tuple(polygon[0]),cv2.FONT_HERSHEY_SIMPLEX,.55,(120,210,160),2)
            for tid,box in persons.items():
                sid=labels.get(tid);member=next((s for s in config['staff'] if s['id']==sid),None)
                obs=next((o for o in observations if o['staffId']==sid),None)
                color=(80,200,100) if obs and obs['state']=='inside' else (50,160,240) if obs and obs['state']=='outside' else (160,160,160)
                cv2.rectangle(frame,(box[0],box[1]),(box[2],box[3]),color,2)
                caption=(member['name']+' · '+obs['state']) if member and obs else 'Unassigned / uncertain'
                role_obs=next((o for o in role_observations if o['trackId']==tid),None)
                if role_obs:
                    role=next(r for r in config['roles'] if r['id']==role_obs['roleId'])
                    caption=role['name']+' / '+role_obs['state']
                    if role_obs['state']=='confirmed':
                        for x,y,_ in poses[tid][[15,16]]:cv2.circle(frame,(int(x),int(y)),5,(80,230,100),-1)
                    else:cv2.putText(frame,role_obs['reason'],(max(0,box[0]),min(height-8,box[1]+38)),cv2.FONT_HERSHEY_SIMPLEX,.45,color,1)
                cv2.putText(frame,caption,(max(0,box[0]),max(20,box[1]-7)),cv2.FONT_HERSHEY_SIMPLEX,.6,color,2)
                if obs and obs['state']=='uncertain' and obs.get('region'):cv2.putText(frame,obs['region'],(max(0,box[0]),min(height-8,box[1]+20)),cv2.FONT_HERSHEY_SIMPLEX,.45,color,1)
            _,jpeg=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,80])
            emit({'type':'frame','frame':base64.b64encode(jpeg).decode(),'workInputMode':'people','workObservations':observations,'roleObservations':role_observations,'workFrameAt':data['frameAt'],'workRevision':config['revision'],'workRuntime':{'state':'ready','message':f"{len(persons)} people visible · {sum(o['state']=='confirmed' for o in role_observations)} confirmed role markers"}})
        except Exception as error:emit({'type':'frame_error','message':str(error)[:150]})


if __name__=='__main__':main()
