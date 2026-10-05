# Camera Control Project

## Scope and constraints

Build a local camera-only home-test prototype: connect an Android RTSP camera,
track people and portable objects, identify pickup candidates, flag sustained
disappearance for human review, and save/review evidence. No shelf hardware,
RFID, weight sensors, or cloud video processing.
An alert is never proof of theft. Camera-only bag placement, body turns,
occlusion and object-ID changes remain imperfect.

The app also includes opt-in extras beyond the anonymous concealment pipeline:
colour-tag role labels, foot-traffic/grouping analytics, and an opt-in face
recognition attendance feature. Face recognition is biometric and off by
default; enrol only people who consent, and note there is no liveness check
yet. Enrolled face data stays local in `face-db.json` (gitignored).

## Implemented components

- `server.js`: loopback Node server, editable RTSP configuration, FFmpeg MJPEG
  bridge, stream timeout/reconnection, bounded one-frame worker protocol.
- `detection.py`: local YOLO11 nano detection, ByteTrack temporary IDs, pose
  matching and wrist markers. Emits a result or frame_error for every input.
- `event_tracker.py`: camera-independent temporal rules with deterministic tests.
- `presence.py`: anonymous foot-traffic counts and "hanging together" grouping.
- `roles.py`: colour-tag role labelling (assign a tag colour to a role).
- `attendance.py`: opt-in face enrolment/recognition via OpenCV YuNet + SFace;
  stored locally in `face-db.json`. Toggled on/off from the dashboard. No
  liveness check; results are an aid, not authority.
- `evidence.js`: durable local events, pre/post video, snapshot storage, H.264
  encoding, interrupted capture recovery, persistent notes/review decisions.
- `public/`: responsive full-frame portrait/landscape viewer, camera/detection
  controls, manual clip capture, review history/filter, playback/download,
  snapshots, review status and notes.
- `models/`, `.venv/`: downloaded models and Python runtime; gitignored.
- `clips/<event-id>/`: local evidence. event.json is written atomically;
  pending JPEG journals are recoverable after restart. Successful H.264 encoding
  removes only the generated temporary JPEG spool, keeping snapshots/video.
- `camera-config.json`: local RTSP URL (may include credentials), gitignored.

## Detection behavior

Pickup is a candidate based on a portable object moving at least 1.5% of the
shorter frame dimension while associated with one person's wrist for 0.6s.
Wrist ownership is matched via the pose person's box, rejecting ambiguous
matches. A stationary object merely near a hand does not arm an alert.

An item visible away from a wrist for 1s is released. Brief missing detections
are tolerated. At 4s missing, alert only if last seen near its owner's wrist
and inside their body, the owner stayed visible away from frame edges, and
pose/other-person occlusion did not introduce uncertainty. Gaps over 2.5s reset
candidates. Temporary IDs are session-scoped. Isolated overlapping object ID
switches can be reassociated. This is a heuristic, not validated theft detection.

## Evidence and review

Raw preview frames are buffered for up to 5s and 32 MB at about 5 FPS. Alerts
capture up to 2.5s afterward. Evidence capture does not depend on inference FPS.
Each event is saved immediately; its journal supports interrupted recovery.
Stopping analysis/disconnecting finalizes shorter clips. Existing legacy clip
folders are imported in place. Notes and decisions survive restarts.

GET /api/alerts lists records and safe media links.
POST /api/alerts/manual saves an explicitly manual clip.
POST /api/alerts/:id/review validates and saves a decision and notes.
GET/HEAD /api/alerts/:id/media/:filename supports Range playback and downloads.
No arbitrary filesystem path is accepted. No automatic retention deletion.

## Run and validate

Run `npm start`, then open http://127.0.0.1:4173.
Current phone address is editable; initial default: rtsp://192.168.1.2:8554.
Python environment: `.venv/Scripts/python.exe`.
Dependencies: `requirements.txt` includes CPU PyTorch, Ultralytics and lapx.
FFmpeg path is currently configured in server.js for this Windows computer.

- `npm run check`: JavaScript syntax.
- `npm run test:tracking`: pickup, release, obstruction, gap and ID-switch rules.
- `npm run test:review`: isolated temporary evidence, encoding/recovery,
  API validation and Range support, Edge playback, review persistence and mobile UI.
- `.venv/Scripts/python verify-worker.py`: real models plus bad-frame recovery.
- `node smoke-detection.js`: connected phone live inference and start/stop/restart;
  leaves detection on and can generate real review clips.

Playwright is a development-only dependency; runtime Node has no external
dependencies. Preserve user clips/configuration and do not use them as test
fixtures. Live thresholds still need evaluation with staged home recordings.
See README.md for setup and operator instructions.
