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

## Face attendance and liveness

Face attendance is opt-in. Enrol only consenting people. The attendance panel
has a separate liveness-screening control; it defaults to OFF when
`livenessEnabled` is absent from `attendance-config.json`. With screening OFF,
YuNet faces go directly to SFace matching and results are marked `DISABLED`.
This setting does not establish that a person is live and should be treated as
a development/testing mode. With screening ON, the local Open Model Zoo
`anti-spoof-mn3` ONNX model gates SFace and attendance as before. With screening
OFF, enrollment does not run the anti-spoof model but still requires exactly one
YuNet-detected face. With screening ON, enrollment requires stable live evidence
and exactly one detected face. Attendance still uses the existing
first-recognition arrival / later recognition departure rules.

Attendance recording is scheduled for a same-day local-time window from
`attendanceStartTime` (inclusive) to `attendanceEndTime` (exclusive). The
defaults are `06:00` and `22:00`; these can be changed in the attendance panel.
Outside the window, face recognition and camera processing continue when
enabled, but recognized faces cannot create or update attendance records.
Incomplete recognition stability is cleared while the window is closed.
Attendance history is retained across window closure and local calendar-day
rollover. The schedule does not start or stop the camera or recognition worker.

For isolated recognition testing without attendance writes, start a separate
process with `CAMERA_RECOGNITION_ONLY=1` set in its environment. For example,
in PowerShell run `$env:CAMERA_RECOGNITION_ONLY='1'; npm start`. This mode refuses
to start unless both attendance and liveness are already disabled in
`attendance-config.json`. The attendance toggle and enrollment form are disabled
in the UI, and neither attendance records nor face enrollment data are written.
Recognition uses only identities already present in the local `face-db.json`;
with no enrolled identities, visible faces are reported as `Unknown`. This
testing mode disables liveness and must not be used for access control,
authorization, or other real-world decisions. Stop the process normally to
leave the mode; do not set this environment variable for ordinary operation.

The anti-spoof model is required at
`models/face_anti_spoof_mn3.onnx`. It is a 12,270,179-byte MobileNetV3 model
trained on CelebA-Spoof, published by
[Open Model Zoo](https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/public/anti-spoof-mn3).
The official file is
[anti-spoof-mn3.onnx](https://storage.openvinotoolkit.org/repositories/open_model_zoo/public/2022.1/anti-spoof-mn3/anti-spoof-mn3.onnx);
its published SHA-384 is
`6de4534964b723397b3e8c995cadcf43bc007cc2f9930b95ae25f76adccece5d1d4d058d0b15117b9e4a9f758424f92a`.
It runs locally through the existing OpenCV DNN dependency; no package or
cloud service is added. Output class 0 means real/live and class 1 means spoof.

The face crop follows the publisher's reference demo: 1.1x width, 1.05x height,
and cubic resize. The publisher's reference spoof decision boundary is 0.4; this
gate requires at least 0.60 confidence for either the live or spoof class and
treats the middle range as inconclusive. At least three live results among the
latest five face samples, spanning at least one second, are required, with no
gap over 2.5 seconds. An inconclusive frame cannot proceed to SFace or
attendance; a confident spoof result clears the live evidence window. Malformed
or failed model results fail closed. The model reports
an ACER of 3.81% on its published benchmark, but this passive RGB check can
still accept presentation attacks or reject real people under different
cameras, lighting, displays, or image quality. It is a risk-reduction aid, not
proof of liveness or identity.

## Setup on another Windows computer

Install Node.js 20+, Python, and FFmpeg. Both `ffmpeg` and `ffprobe` must be
available on your system `PATH`. To use executables outside `PATH`, set
`FFMPEG_PATH` and `FFPROBE_PATH` to their executable paths before starting the
application or running the review test. Then run:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
```

Put the official [YOLO11 nano detection model](https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt)
and [YOLO11 nano pose model](https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt)
in `models/`. Face attendance uses the versioned OpenCV Zoo ONNX files below.
The source is pinned to OpenCV Zoo commit
[`47534e27c9851bb1128ccc0102f1145e27f23f98`](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models).

| File in `models/` | Official asset | License | SHA-256 |
| --- | --- | --- | --- |
| `face_detection_yunet_2026may.onnx` | [YuNet](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2026may.onnx) | MIT | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` |
| `face_recognition_sface_2021dec.onnx` | [SFace](https://github.com/opencv/opencv_zoo/blob/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface/face_recognition_sface_2021dec.onnx) | Apache-2.0 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

These SHA-256 values are published in the official Git LFS pointer metadata.
YuNet's 2026may file has dynamic input dimensions for OpenCV 5.x; the worker
uses OpenCV's `FaceDetectorYN` and `FaceRecognizerSF` APIs. Keep the versioned
filenames unchanged. The liveness model described above is separate and is only
needed when liveness screening is enabled. Runtime video processing is local.
Setup requires internet downloads.
Review the [Ultralytics license](https://www.ultralytics.com/license) before commercial distribution.

For browser validation, run `npm install` to install the development-only
Playwright library; the review test uses the existing Microsoft Edge installation.

## Validation

`npm run check` checks JavaScript syntax. With the server and camera connected,
`node smoke-detection.js` verifies live annotated bytes, detection metrics,
stopping, and restarting detection. It leaves detection running for manual testing.
`.venv/Scripts/python verify-worker.py` checks the real models against their
bundled sample, including wrist detections and preservation of frame dimensions.
`npm run test:liveness` exercises both recognition modes, model-result
classification, stability, fail-closed behavior, and the SFace gate.
`npm run test:tracking` covers temporal rules without a camera.
`npm run test:attendance` covers the daily attendance rules and accepts either
`LIVE` or explicitly `DISABLED` face results only when they match the
configured liveness mode.
`npm run test:recognition-only` covers recognition-only settings, known and
unknown recognition results with local model initialization, attendance-write
suppression, and UI status reporting without camera input or identity-file
writes.
`npm run test:review` uses isolated temporary fixtures to validate encoding,
interrupted recovery, playback/seek, review persistence, API errors, and the UI.

The local server listens only on `127.0.0.1`. The generated `camera-config.json`
is ignored by Git and may contain the camera password; keep it private.
