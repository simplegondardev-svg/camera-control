"""Customer-zone facial movement worker. Never loads identity or attendance data."""
import base64
import json
import sys
import time
from pathlib import Path
import cv2
import numpy as np
from face_state import FaceStateWorker, label_for
from checkout_tracker import CheckoutTracker


def emit(data):
    print(json.dumps(data), flush=True)


def main():
    config, tracker = None, None
    expression_worker = FaceStateWorker(Path(__file__).parent / 'models/face_landmarker.task')
    last_sequence = 0
    emit({'type': 'ready'})
    for line in sys.stdin:
        try:
            data = json.loads(line)
            if 'checkoutConfig' in data:
                config = data['checkoutConfig']
                tracker = CheckoutTracker(config['sustainSeconds'], config['threshold'], config['cooldownSeconds'], config.get('signal', 'either'))
                expression_worker.set_enabled(True)
                continue
            if 'frame' not in data:
                continue
            frame = cv2.imdecode(np.frombuffer(base64.b64decode(data['frame']), np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError('Invalid camera frame')
            events, faces, message, state = [], [], 'Draw and save a customer zone.', 'waiting'
            signals = []
            if config and config['zone']:
                try:
                    height, width = frame.shape[:2]
                    zone = config['zone']
                    x, y = int(zone['x']*width), int(zone['y']*height)
                    right, bottom = min(width, int((zone['x']+zone['width'])*width)), min(height, int((zone['y']+zone['height'])*height))
                    crop = frame[y:bottom, x:right]
                    if min(crop.shape[:2]) < 20:
                        raise ValueError('Customer zone is too small')
                    expression_worker.submit(crop.copy(), data['frameAt'], config['revision'])
                    observation = expression_worker.get_observation()
                    fresh = observation['context'] == config['revision'] and observation['frameAt'] is not None and 0 <= data['frameAt']-observation['frameAt'] <= 2500
                    if observation['error']:
                        raise RuntimeError(observation['error'])
                    if fresh:
                        faces = observation['results']
                        if observation['sequence'] != last_sequence:
                            events = tracker.update(faces, observation['frameAt']/1000)
                            last_sequence = observation['sequence']
                        state = 'ready'
                        for face in faces:
                            brow, mouth = face['brow_score'], face.get('mouth_frown_score', 0)
                            mode = config.get('signal', 'either')
                            score = mouth if mode == 'mouth' else brow if mode == 'brow' else max(brow, mouth)
                            signals.append({'brow':round(brow,3),'mouth':round(mouth,3),'selected':round(score,3)})
                            face['selected_score'] = score
                        frowns = sum(face['selected_score'] >= config['threshold'] for face in faces)
                        smiles = sum(face['smile'] for face in faces)
                        message = f"{len(faces)} face(s) · frown {frowns} · smile {smiles} · hold frown {config['sustainSeconds']}s to save"
                    else:
                        state, message = 'loading', 'Warming up the expression model… preview remains live.'
                    for face in faces:
                        left, top, r, b = face['box']
                        detected = face['selected_score'] >= config['threshold']
                        color = (60, 160, 240) if detected else (130, 220, 140)
                        cv2.rectangle(frame, (x+left, y+top), (x+r, y+b), color, 2)
                        selected_signal = 'mouth' if config.get('signal') == 'mouth' or (config.get('signal', 'either') == 'either' and face.get('mouth_frown_score', 0) > face['brow_score']) else 'brows'
                        caption = f"frown ({selected_signal}) {face['selected_score']:.2f}" if detected else ('smile' if face['smile'] else 'neutral')
                        cv2.putText(frame, caption, (max(0, x+left), max(20, y+top-7)), cv2.FONT_HERSHEY_SIMPLEX, .6, color, 2)
                    cv2.rectangle(frame, (x,y), (right,bottom), (130,220,140), 2)
                except Exception as error:
                    print(f'Checkout detector: {error}', file=sys.stderr)
                    tracker = CheckoutTracker(config['sustainSeconds'], config['threshold'], config['cooldownSeconds'], config.get('signal', 'either'))
                    state, message = 'error', 'Face detector unavailable. Check the model and customer zone.'
                    faces, events = [], []
            ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                raise ValueError('Preview encoding failed')
            emit({'type':'frame', 'frame':base64.b64encode(jpeg).decode(), 'checkoutEvents':events,
                  'checkoutRuntime':{'state':state,'message':message,'faces':len(faces),'signals':signals}, 'checkoutRevision':config['revision'] if config else None})
        except Exception as error:
            emit({'type':'frame_error','message':str(error)[:150]})


if __name__ == '__main__':
    main()
