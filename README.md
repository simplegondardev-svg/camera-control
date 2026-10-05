# Camera Control

Local Android RTSP preview, person/object tracking, disappearance review alerts,
and a saved evidence review dashboard.

## Run

```powershell
npm start
```

Open http://127.0.0.1:4173, enter the phone's RTSP address, and connect.
The phone and computer need to be on the same network with the phone's RTSP
server running. The viewer automatically follows portrait or landscape frames.

Select **Start detection** to load the local models. The analyzed preview may
run more slowly than the normal preview, depending on CPU speed. Frames are
processed one at a time without building an analysis backlog.

- Green boxes: people.
- Blue boxes: recognized object categories.
- Pink dots: wrists visible to the pose model.
- Yellow boxes: a moving portable object associated with a visible wrist.

For testing, stand far enough back for your arms to be visible, hold a bottle
or cup in good lighting, and move it slowly. Stop detection to return to the
ordinary preview. Items moving near an unambiguous person's wrist for at least
0.6 seconds become pickup candidates. Visible items away from the wrist for a
second are released. An item missing for at least four seconds can raise a
review alert if it was last near the body and the same person remains visible.
Camera interruptions, uncertain pose, other-person obstruction, and exits
cancel the candidate. These are conservative heuristics, not proof of possession
or concealment; bag placement, turns, missed detections and tracker mistakes can
still cause false positives or missed events. Arbitrary product recognition is
limited to the pretrained model's categories. No facial identification is used.

## Review clips

Automatic alerts appear in **Review history**. **Save a review clip** creates an
explicitly manual event for testing or investigation. Open a review to watch or
download the H.264 clip, view pickup/alert snapshots, add notes, and mark it
Confirmed, False alert, Unclear, or Unreviewed. Confirmed means the operator's
review decision, not an automated theft verdict.

Evidence is saved in `clips/<id>/`. Clips include up to five seconds before and
2.5 seconds after the alert, sampled at about five frames per second. Clip
timing follows the source timestamps. Recording is independent of model speed.
Stopping/disconnecting finalizes available footage as a shortened clip. After
an unexpected process exit, the next start recovers interrupted captures from
their JPEG journals. Snapshots and failed-encoding source frames are preserved.
Existing legacy folders are imported without deleting or overwriting their files.

Reviews and notes survive application restarts and detection stops. They are
stored locally with no automatic deletion; monitor available disk space.
The preview automatically retries a lost camera connection every five seconds
and resumes detection if it was previously enabled. A new connection creates
fresh tracking identities.

## Setup on another Windows computer

Install Node.js 20+, Python, and FFmpeg. Update the FFmpeg path in `server.js`
for your installation. Then run:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
```

Put the official [YOLO11 nano detection model](https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt)
and [YOLO11 nano pose model](https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt)
in `models/`. Runtime video processing is local. Setup requires internet downloads.
Review the [Ultralytics license](https://www.ultralytics.com/license) before commercial distribution.

For browser validation, run `npm install` to install the development-only
Playwright library; the review test uses the existing Microsoft Edge installation.

## Validation

`npm run check` checks JavaScript syntax. With the server and camera connected,
`node smoke-detection.js` verifies live annotated bytes, detection metrics,
stopping, and restarting detection. It leaves detection running for manual testing.
`.venv/Scripts/python verify-worker.py` checks the real models against their
bundled sample, including wrist detections and preservation of frame dimensions.
`npm run test:tracking` covers temporal rules without a camera.
`npm run test:review` uses isolated temporary fixtures to validate encoding,
interrupted recovery, playback/seek, review persistence, API errors, and the UI.

The local server listens only on `127.0.0.1`. The generated `camera-config.json`
is ignored by Git and may contain the camera password; keep it private.
