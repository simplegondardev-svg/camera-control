# Attendance Desk

Local camera face attendance station with staff profiles, individual schedules,
explicit check-in/check-out scans, and SQLite storage.

## Attendance workflow

Run `npm start` and open http://127.0.0.1:4173. Node.js 22.13+ is required
for its built-in SQLite driver; this PC uses Node.js 24. No database server
or additional Node package is needed.

1. Open **Staff & schedules**, then **Add staff member**. Enter a name, unique
   staff ID, department, working days, start/end times, and grace minutes.
2. For a short test, use **Use a one-minute test shift**. It sets today's
   working day and a one-minute shift with zero grace. Any one-minute shift
   is valid, including 23:59–00:00; end times before start mean overnight work.
3. Connect the RTSP camera under **Camera setup** and press **Start station**.
4. Select the saved staff profile, confirm consent, and **Capture face**.
   Capture up to five samples per person. Only one face may be visible.
5. Press **Check in** or **Check out**, then look at the camera. The scan has
   20 seconds to recognize one enrolled face, with three consistent frames
   spanning at least one second. Sightings without an armed scan never record
   attendance. Multiple faces, unknown identities and failed liveness cannot
   confirm a scan. Camera interruptions cancel the pending scan.
6. Review **Daily attendance** or **Attendance log**, and export a date as CSV.

Each IN opens a session and each OUT closes it. Repeated INs and OUTs without
an open session are rejected. A three-second cooldown prevents accidental
immediate repeats; it allows one-minute work sessions without needing a person
to leave the picture. Multiple work sessions per day are supported. The first
IN and final OUT appear in the daily table; completed minutes sum closed
sessions. Overnight OUTs stay attached to the original shift date.

Lateness measures minutes beyond the individual's grace period; early
departure compares OUT to that session's scheduled end. Scans outside a
scheduled workday remain possible and are marked unscheduled. Schedules do
not block short tests. The camera's older global operating window does not
gate station scans. The system never invents checkouts or marks someone absent
because the camera is offline.

Staff, schedules, binary float32 face embeddings, scanner settings, sessions,
and scan events live in `attendance.sqlite` (gitignored), shared locally by
Node and Python using WAL mode. Initial startup imports existing face samples
and attendance history once from the legacy JSON files in one transaction.
Original files remain untouched; imported records are labeled Legacy. Review
the default working schedules assigned to imported staff. Deactivation
retains history and excludes the person from recognition.
Legacy records do not establish a current checked-in state. When a new explicit
session exists on the same date, the daily table uses the station session;
original legacy entries remain in SQLite and the archived JSON file.

`npm run test:station` checks the SQLite rules, migration, API, CSV and
desktop/mobile UI using temporary fixtures. Run
`.venv/Scripts/python -m unittest discover -p "test_*.py" -v` for Python
regressions and the face-only worker/model checks. The station uses
`attendance-worker.py`; object and expression models are not run in this mode.

## Checkout review

Open **Checkout review** in the sidebar (or `/checkout.html`). Connect the
camera, drag over the customer's position, and save the zone and checkout
name. Alternatively select **Use full frame for testing**, then save.
Press **Start monitoring**. With the current single camera, this switches
off attendance recognition; starting the attendance station switches back.
The checkout worker never loads staff identity models or face embeddings.

Choose brow lowering, downturned-mouth movement, or either under **Frown signal
source**. Both separate model scores are displayed live for tuning; they are
signal strengths, not probabilities or customer mood assessments. Existing
recorded brow-only events retain their original labels. A visible selected
signal above the default 0.30 threshold must persist across
at least three samples and one second. Temporary geometric tracking suppresses
repeated events while the signal continues; a neutral period and the default
20-second cooldown allow a new event. Missing/ambiguous faces, detector errors
and camera interruptions clear incomplete candidates. Tracking does not identify
customers or link their visits. Camera interruptions can lose temporary tracks.
The preview reuses the original smile/frown/neutral expression labels and
background inference worker. Only fresh model samples contribute to events;
repeated cached results never accumulate signal duration. Head-direction
labels do not suppress an otherwise detected frown. Model warm-up is shown
explicitly while the camera preview continues running.

Events store the checkout name, first observed time, confirmation timestamp,
signal duration at confirmation, and brow score in SQLite. Clips use the
existing local recorder with up to five seconds of preceding footage and five
seconds after capture starts. Shortened captures and failed encodes remain
visible. Clip journals support interrupted recovery; saved metadata reconciles
checkout records after a restart. Review a selected date, watch/download a clip,
mark Reviewed / False detection / Unclear, add observed operational context
and notes. These are facial-movement review cues, not customer mood ratings.
There is no automatic clip deletion; retention remains operator-controlled.

Run `npm run test:checkout` to validate tracking, SQLite events/reviews, media,
real model loading, and desktop/mobile UI with temporary fixtures.

## Earlier camera workspace (reference)

The previous camera UI is retained at `/index.html` for future work. Its
object-analysis worker can be selected with `CAMERA_FEATURE_MODE=vision`.
The following sections document those earlier features; attendance setup
and scanning should use the workflow above.

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

Install Node.js 22.13+, Python, and FFmpeg. Both `ffmpeg` and `ffprobe` must be
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

### Staff work areas

Open `/workareas.html` or choose Work areas in the sidebar. Check staff in through
the attendance station first. Draw floor regions on a fixed camera view, assign
each staff member a distinct bright color marker and their allowed regions, then
start tracking. The camera should show people from their upper body to their feet.
The five-second allowance shortcut is useful for testing outside-area events.

Multiple staff can be tracked together during their open attendance sessions.
The midpoint of two ankle landmarks determines the region. Both ankles require at least 70% model confidence; missing, cropped or unreliable landmarks produce uncertainty and reset the outside timer. The UI shows this protection and draws green ankle dots. Pose confidence is an estimate, so review errors during real-camera testing. Reports and timelines store inside,
outside, uncertain and unobserved durations in SQLite, with review notes for
outside events. Missing markers, overlapping people, region boundaries and camera
gaps do not count as confirmed outside time. Another person wearing the same
color can be confused with a staff member; review exceptions before acting on them.
One camera runs attendance, checkout or work-area detection at a time.
`npm run test:workareas` checks the database, browser UI and real person-model worker.

The Role gatherings panel reuses these polygons. Save distinct role colors,
choose a region, and set minimum counts (Sales 1 + Cashier 1, or Sales 3) and
a sustained duration. The five-second shortcut supports quick testing. Regions
without enabled rules are excluded. Shared role colors count separate temporary
person tracks and do not identify named employees or require attendance check-in.
Use role markers with different colors from personal work-area markers.
Live counts, timers, timestamped events, duration and review notes use SQLite.
Missing ankles, unreadable markers, overlap, camera gaps and departure of a
required person reset the timer; extra arrivals do not restart an existing group.
These observations establish shared region occupancy, not conversation or intent.
`npm run test:gatherings` checks the tracking rules, persistence and browser UI.

For a tabletop rehearsal, select **Tracking input → Tabletop test** and apply
the mode. Point the camera down at a plain table, draw regions on the image,
and choose role colors matching bright saturated paper. Each separate paper
piece is a temporary role token; its center determines its region. Keep pieces
apart, avoid similarly colored backgrounds and move slowly. Touching pieces
can merge, while fast or ambiguous movement resets identity and timers.
Use the same gathering rules and the five-second shortcut. Paper events are
stored with `input_mode=tabletop` and displayed with TEST labels. Mode changes
reset timers. Individual staff location recording is paused in paper mode;
switch back to People for ankle checks and actual staff tracking.
`.venv/Scripts/python -m unittest test_tabletop_tracking -v` tests paper tracking
and the complete worker protocol without person detections.

The local server listens only on `127.0.0.1`. The generated `camera-config.json`
is ignored by Git and may contain the camera password; keep it private.

Tabletop mode also supports Black plastic (#000000) and White paper (#ffffff) role presets. Use a plain mid-gray or brown surface with even lighting. Very dark shadows or bright reflections can produce false pieces. Black/white roles are ignored in People mode; saturated color markers remain required there.


For a minimal full-frame preview, open /blackwhite.html (Black & White in navigation). Connect the camera and start detection. This mode uses brightness masks and needs no staff, roles, regions or rules. Orange boxes show black regions; blue boxes show white regions. Large frame backgrounds are suppressed; shadows, highlights and touching objects can affect counts.


The simple preview now detects Pink & White instead of Black & White to avoid dark shadows counting as black items. Existing /blackwhite.html and API addresses remain compatible. Pink uses a saturated pink/magenta hue mask; white still uses low saturation and high brightness.


Pink & White now supports drawing shared SQLite work regions directly on its preview: Draw area, click at least three corners, name it and Save area. Each region lists live pink/white counts using normalized component centroids, with near-boundary centers excluded. Undo point and Cancel correct a draft; Remove deletes a saved area unless a staff assignment or gathering rule still uses it.

Under Staying-together timers, choose an area, minimum pink/white counts and
duration (five seconds by default), then save. Use Pink 1 + White 1 for mixed
groups, or Pink 3 + White 0 for same-color groups. The server tracks a stable
minimum cohort; required departures, missing/cropped/ambiguous pieces, camera
gaps, edits and stops reset its timer. Extra arrivals do not reset a retained
cohort. SQLite records one TEST event per continuous gathering, with start,
confirmation, last observed/end time, duration and review notes. Events remain
available after restart. Each area can have its own rules. Pieces are temporary
visual tracks, so fast movement or touching pieces can disrupt identity.
`node test-preview-gatherings.js` checks timers, persistence and the real API.

