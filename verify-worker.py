"""Exercise both real models on Ultralytics' bundled sample (no camera needed)."""
import base64
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

root = Path(__file__).parent
sample = root / '.venv/Lib/site-packages/ultralytics/assets/bus.jpg'
original = cv2.imread(str(sample))
assert original is not None, 'Missing bundled validation image'
payload = json.dumps({'frame': base64.b64encode(sample.read_bytes()).decode()})
result = subprocess.run([sys.executable, '-u', str(root / 'detection.py')], input='not-json\n'+payload+'\n',
                        text=True, capture_output=True, timeout=90, cwd=root)
assert result.returncode == 0, result.stderr
messages = []
for line in result.stdout.splitlines():
    try:
        messages.append(json.loads(line))
    except json.JSONDecodeError:
        pass
frames = [message for message in messages if message.get('type') == 'frame']
assert any(message.get('type') == 'frame_error' for message in messages), 'Bad input must release the frame request'
assert len(frames) == 1, result.stdout[:1000]
frame = frames[0]
decoded = cv2.imdecode(np.frombuffer(base64.b64decode(frame.pop('frame')), dtype=np.uint8), cv2.IMREAD_COLOR)
assert decoded.shape == original.shape, 'Annotations must preserve the complete source frame'
assert frame['people'] > 0, 'Expected people in bundled sample'
assert frame['objects'] > 0, 'Expected objects in bundled sample'
assert frame['wrists'] > 0, 'Expected visible wrists in bundled sample'
_, baseline_jpeg = cv2.imencode('.jpg', original, [cv2.IMWRITE_JPEG_QUALITY, 80])
baseline = cv2.imdecode(baseline_jpeg, cv2.IMREAD_COLOR)
near_color = lambda image, color: np.max(
    np.abs(image.astype(np.int16) - np.array(color, dtype=np.int16)), axis=2) <= 36
person_overlay_pixels = np.count_nonzero(near_color(decoded, (80, 220, 140)))
person_baseline_pixels = np.count_nonzero(near_color(baseline, (80, 220, 140)))
object_overlay_pixels = np.count_nonzero(near_color(decoded, (240, 180, 70)))
object_baseline_pixels = np.count_nonzero(near_color(baseline, (240, 180, 70)))
assert person_overlay_pixels > person_baseline_pixels + 20, 'Expected visible person boxes/labels'
assert object_overlay_pixels <= object_baseline_pixels + 20, 'Generic object boxes/labels must stay off the live overlay'
print('PASS: real model inference, person overlay, hidden object overlay, wrists and full frame dimensions', frame)
