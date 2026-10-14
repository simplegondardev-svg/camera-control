const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EvidenceStore } = require('./evidence');
const { sanitizeRecognitionRuntime } = require('./recognition-runtime');
const {
  canEnrollFaces,
  isRecognitionOnlyMode,
  recordAttendanceIfAllowed,
  validateRecognitionOnlySettings,
} = require('./recognition-mode');
const {
  AttendanceStore,
  DEFAULT_ATTENDANCE_END_TIME,
  DEFAULT_ATTENDANCE_START_TIME,
  isAttendanceWindowActive,
  isValidAttendanceTime,
  normalizeAttendanceSchedule,
} = require('./attendance');

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_FILE = path.join(__dirname, "camera-config.json");
const ROLES_FILE = path.join(__dirname, "roles-config.json");
const ATTENDANCE_FILE = path.join(__dirname, "attendance-config.json");
const GENERIC_FILE = path.join(__dirname, "generic-config.json");
const FACESTATE_FILE = path.join(__dirname, "facestate-config.json");
const DEFAULT_URL = "rtsp://192.168.1.2:8554";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const evidence = new EvidenceStore(process.env.CAMERA_DATA_DIR || path.join(__dirname, 'clips'), FFMPEG);
const attendanceStore = new AttendanceStore(path.join(__dirname, 'attendance-records.json'));

const clients = new Set();
let ffmpeg = null;
let ffmpegAttemptId = 0;
let ffmpegStderrTail = "";
let jpegBuffer = Buffer.alloc(0);
let detector = null;
let detectorReady = false;
let detectorBusy = false;
let detectionTimer = null;
let detection = { state: "off", message: "Detection is off" };
let currentFrame = null;
let analyzedFrame = null;
let reconnectTimer = null;
let reconnectAttemptId = null;
let reconnectTimerActive = false;
let streamWatchdog = null;
let desiredUrl = null;
let wantsDetection = false;
let roles = readRoles();
let attendanceConfig = readAttendanceConfig();
let attendanceEnabled = attendanceConfig.enabled;
let livenessEnabled = attendanceConfig.livenessEnabled;
const recognitionOnlyMode = isRecognitionOnlyMode(process.env);
validateRecognitionOnlySettings(recognitionOnlyMode, attendanceEnabled, livenessEnabled);
let recognitionRuntime = recognitionOnlyMode
  ? { state: "stopped", message: "Recognition-only mode is active; detection is not running." }
  : attendanceEnabled
  ? { state: "stopped", message: "Enabled in settings; detection is not running." }
  : { state: "disabled", message: "Face recognition is disabled in settings." };
let genericEnabled = readGeneric();
let faceStateEnabled = readFaceState();
let lastEnroll = null;
let attendanceError = null;

function readAttendanceConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, "utf8"));
    const schedule = normalizeAttendanceSchedule(
      config.attendanceStartTime,
      config.attendanceEndTime,
    );
    return {
      enabled: config.enabled === true,
      livenessEnabled: config.livenessEnabled === true,
      ...schedule,
    };
  } catch {
    return {
      enabled: false,
      livenessEnabled: false,
      attendanceStartTime: DEFAULT_ATTENDANCE_START_TIME,
      attendanceEndTime: DEFAULT_ATTENDANCE_END_TIME,
    };
  }
}

function readGeneric() {
  try { return JSON.parse(fs.readFileSync(GENERIC_FILE, "utf8")).enabled === true; }
  catch { return false; }
}

function readFaceState() {
  try { return JSON.parse(fs.readFileSync(FACESTATE_FILE, "utf8")).enabled === true; }
  catch { return false; }
}

function sendLine(worker, payload) {
  try { worker?.stdin.write(JSON.stringify(payload) + "\n"); } catch { /* worker gone */ }
}

function readRoles() {
  try { return normalizeRoles(JSON.parse(fs.readFileSync(ROLES_FILE, "utf8")).roles); }
  catch { return []; }
}

function normalizeRoles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.reduce((list, entry) => {
    const name = String(entry?.name ?? "").trim().slice(0, 40);
    const color = String(entry?.color ?? "").trim();
    if (name && /^#[0-9a-fA-F]{6}$/.test(color) && !seen.has(name.toLowerCase()) && list.length < 8) {
      seen.add(name.toLowerCase());
      list.push({ name, color: color.toLowerCase() });
    }
    return list;
  }, []);
}

function sendRoles(worker) {
  try { worker?.stdin.write(JSON.stringify({ roles }) + "\n"); } catch { /* worker gone */ }
}

function stopDetection(preserveIntent = false) {
  if (!preserveIntent) wantsDetection = false;
  clearTimeout(detectionTimer);
  const previous = detector;
  detector = null;
  detectorReady = false;
  detectorBusy = false;
  evidence.finishPending();
  previous?.kill();
  detection = { state: "off", message: "Detection is off" };
  recognitionRuntime = recognitionOnlyMode
    ? { state: "stopped", message: "Recognition-only mode is active; detection is not running." }
    : attendanceEnabled
    ? { state: "stopped", message: "Enabled in settings; detection is not running." }
    : { state: "disabled", message: "Face recognition is disabled in settings." };
}

function startDetection() {
  stopDetection(true);
  wantsDetection = true;
  recognitionRuntime = recognitionOnlyMode
    ? { state: "initializing", message: "Recognition-only test mode is initializing." }
    : attendanceEnabled
    ? { state: "initializing", message: "Enabled in settings; initializing face recognition." }
    : { state: "disabled", message: "Face recognition is disabled in settings." };
  detection = { state: "loading", message: "Loading detection models…" };
  const worker = spawn(path.join(__dirname, ".venv/Scripts/python.exe"), ["-u", path.join(__dirname, "detection.py")], { cwd: __dirname, windowsHide: true });
  let frameErrors = 0;
  let stderrTail = "";
  detector = worker;
  const fail = (extra) => {
    if (detector !== worker) return;
    const reason = String(extra || stderrTail).trim().split(/\r?\n/).filter(Boolean).at(-1);
    stopDetection();
    detection = { state: "error", message: "Detection stopped. Check Python dependencies and model files, then retry." + (reason ? ` (${reason.slice(0, 160)})` : "") };
  };
  detectionTimer = setTimeout(fail, 60000);
  worker.on("error", (error) => fail(error.message));
  worker.on("exit", (code) => fail(code === null ? "" : `worker exited (code ${code})`));
  worker.stdin.on("error", fail);
  worker.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
  readline.createInterface({ input: worker.stdout }).on("line", line => {
    if (detector !== worker) return;
    let result;
    try { result = JSON.parse(line); } catch { return; }
    if (result.type === "ready") {
      clearTimeout(detectionTimer);
      detectorReady = true;
      sendRoles(worker);
      sendLine(worker, { attendance: recognitionOnlyMode ? false : attendanceEnabled });
      sendLine(worker, { livenessEnabled });
      sendLine(worker, { generic: genericEnabled });
      sendLine(worker, { faceState: faceStateEnabled });
      sendLine(worker, { recognitionOnly: recognitionOnlyMode });
      detection = { state: "running", message: "Waiting for a camera frame" };
    } else if (result.type === "recognition_status") {
      recognitionRuntime = sanitizeRecognitionRuntime(result.recognitionRuntime);
    } else if (result.type === "frame") {
      clearTimeout(detectionTimer);
      detectorBusy = false;
      frameErrors = 0;
      const { frame, type, events = [], enrolled, ...metrics } = result;
      try {
        recordAttendanceIfAllowed(attendanceEnabled, recognitionOnlyMode, () => {
          attendanceStore.observe(metrics.faces, {
            livenessEnabled,
            attendanceStartTime: attendanceConfig.attendanceStartTime,
            attendanceEndTime: attendanceConfig.attendanceEndTime,
          });
        });
        if (attendanceEnabled && !recognitionOnlyMode) {
          attendanceError = null;
        }
      } catch (error) {
        if (attendanceEnabled && !recognitionOnlyMode) {
          attendanceError = error.message;
          console.error('Attendance persistence failed:', error);
        }
      }
      for (const event of events) evidence.begin(event, analyzedFrame || currentFrame);
      if (enrolled) lastEnroll = { ...enrolled, at: new Date().toISOString() };
      detection = { state: "running", message: "Detection active", updatedAt: new Date().toISOString(), ...metrics, enrollStatus: lastEnroll };
      sendFrame(Buffer.from(frame, "base64"));
    } else if (result.type === 'frame_error' || result.type === 'log') {
      clearTimeout(detectionTimer);
      detectorBusy = false;
      detection.message = 'Could not analyze a frame; retrying.';
      if (currentFrame) sendFrame(currentFrame);
      if (++frameErrors >= 3) fail();
    } else if (result.type === "error") {
      fail();
    }
  });
}
let status = {
  state: "idle",
  message: "Ready to connect",
  connectedAt: null,
  lastFrameAt: null,
};

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { rtspUrl: parsed.rtspUrl || DEFAULT_URL };
  } catch {
    return { rtspUrl: DEFAULT_URL };
  }
}

function writeJson(response, code, data) {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function safeRtspUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "rtsp:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function publicRtspUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "••••••••";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function sanitizeCameraDiagnostic(value) {
  return String(value ?? "")
    .replace(/\brtsps?:\/\/[^\s"'<>]+/gi, "[RTSP URL redacted]")
    .replace(/([?&](?:username|user|password|passwd|pwd|token|access_token|auth|authorization|key|secret)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, "$1: [redacted]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9+/=_-]+/gi, "$1 [redacted]");
}

function logCameraDiagnostic(event, details = {}) {
  const safeDetails = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeCameraDiagnostic(value).slice(-1200) : value,
    ]),
  );
  console.info(JSON.stringify({
    component: "camera",
    timestamp: new Date().toISOString(),
    event,
    ...safeDetails,
  }));
}

function logCameraStateTransition(from, to, attemptId, ffmpegCurrent, ffmpegWasCurrent = ffmpegCurrent) {
  if (from === to) return;
  logCameraDiagnostic("state.transition", { from, to, attemptId, ffmpegCurrent, ffmpegWasCurrent });
}

function stopStream(message = "Stream disconnected") {
  const previousState = status.state;
  const stoppedAttemptId = ffmpegAttemptId;
  const hadCurrentFfmpeg = Boolean(ffmpeg);
  desiredUrl = null;
  if (reconnectTimer && reconnectTimerActive) {
    logCameraDiagnostic("retry.cancelled", {
      attemptId: reconnectAttemptId ?? stoppedAttemptId,
      reason: message === "Connecting…" ? "stream_replaced" : "stream_stopped",
    });
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttemptId = null;
  reconnectTimerActive = false;
  clearTimeout(streamWatchdog);
  stopDetection();
  if (ffmpeg) {
    ffmpeg.kill();
    ffmpeg = null;
  }
  jpegBuffer = Buffer.alloc(0);
  currentFrame = null;
  evidence.resetBuffer();
  status = { state: "idle", message, connectedAt: null, lastFrameAt: null };
  logCameraStateTransition(previousState, status.state, stoppedAttemptId, false, hadCurrentFfmpeg);
}

function broadcastFrame(frame) {
  currentFrame = frame;
  evidence.addFrame(frame);
  clearTimeout(streamWatchdog);
  const watchdogAttemptId = ffmpegAttemptId;
  const watchdogProcess = ffmpeg;
  streamWatchdog = setTimeout(() => {
    logCameraDiagnostic("watchdog.fired", {
      attemptId: watchdogAttemptId,
      attemptIsCurrent: watchdogAttemptId === ffmpegAttemptId,
      ffmpegIsCurrentChild: watchdogProcess !== null && ffmpeg === watchdogProcess,
    });
    reconnectStream();
  }, 15000);
  status.lastFrameAt = new Date().toISOString();
  if (status.state !== "connected") {
    const previousState = status.state;
    status.state = "connected";
    status.message = "Live stream connected";
    status.connectedAt = status.lastFrameAt;
    logCameraStateTransition(previousState, status.state, ffmpegAttemptId, Boolean(ffmpeg));
    if (wantsDetection && !detector) startDetection();
  }
  if (detectorReady && detector) {
    if (!detectorBusy) {
      detectorBusy = true;
      analyzedFrame = frame;
      detectionTimer = setTimeout(() => {
        stopDetection();
        detection = { state: "error", message: "Analysis timed out. Try starting detection again." };
      }, 30000);
      detector.stdin.write(JSON.stringify({ frame: frame.toString("base64") }) + "\n");
    }
    return;
  }
  sendFrame(frame);
}

function sendFrame(frame) {
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
  );
  const ending = Buffer.from("\r\n");
  for (const client of clients) {
    if (!client.destroyed && client.writableLength < 2_000_000) client.write(Buffer.concat([header, frame, ending]));
  }
}

function extractFrames(chunk) {
  jpegBuffer = Buffer.concat([jpegBuffer, chunk]);
  while (true) {
    const start = jpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      jpegBuffer = jpegBuffer.subarray(Math.max(0, jpegBuffer.length - 1));
      return;
    }
    const end = jpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (start > 0) jpegBuffer = jpegBuffer.subarray(start);
      return;
    }
    broadcastFrame(jpegBuffer.subarray(start, end + 2));
    jpegBuffer = jpegBuffer.subarray(end + 2);
  }
}

function startStream(rtspUrl) {
  const resumeDetection = wantsDetection;
  stopStream("Connecting…");
  wantsDetection = resumeDetection;
  const attemptId = ++ffmpegAttemptId;
  let stderrTail = "";
  ffmpegStderrTail = "";
  desiredUrl = rtspUrl;
  streamWatchdog = setTimeout(() => {
    logCameraDiagnostic("watchdog.fired", {
      attemptId,
      attemptIsCurrent: attemptId === ffmpegAttemptId,
      ffmpegIsCurrentChild: attemptId === ffmpegAttemptId && Boolean(ffmpeg),
    });
    reconnectStream();
  }, 20000);
  status = { state: "connecting", message: "Opening camera stream…", connectedAt: null, lastFrameAt: null };
  logCameraStateTransition("idle", status.state, attemptId, false);

  try {
    ffmpeg = spawn(FFMPEG, [
      "-hide_banner",
      "-loglevel", "warning",
      "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-an",
      "-vf", "fps=15,scale='min(1280,iw)':-2",
      "-q:v", "5",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ], { windowsHide: true });
  } catch (error) {
    logCameraDiagnostic("ffmpeg.spawn_error", {
      attemptId,
      ffmpegCurrent: false,
      error: error.message,
    });
    throw error;
  }

  const processForStream = ffmpeg;
  processForStream.on("spawn", () => {
    logCameraDiagnostic("ffmpeg.spawn", {
      attemptId,
      ffmpegCurrent: ffmpeg === processForStream,
    });
  });
  ffmpeg.stdout.on("data", chunk => { if (ffmpeg === processForStream) extractFrames(chunk); });
  ffmpeg.stderr.on("data", (chunk) => {
    if (ffmpeg !== processForStream) return;
    stderrTail = (stderrTail + chunk.toString()).slice(-2048);
    ffmpegStderrTail = stderrTail;
    const line = chunk.toString().trim().split(/\r?\n/).at(-1);
    if (line && status.state !== "connected") {
      status.message = sanitizeCameraDiagnostic(line).slice(0, 180);
    }
  });
  ffmpeg.on("error", (error) => {
    const ffmpegCurrent = ffmpeg === processForStream;
    logCameraDiagnostic("ffmpeg.error", {
      attemptId,
      ffmpegCurrent,
      error: error.message,
    });
    if (ffmpegCurrent) reconnectStream();
  });
  ffmpeg.on("exit", (code, signal) => {
    const ffmpegCurrent = ffmpeg === processForStream;
    logCameraDiagnostic("ffmpeg.exit", { attemptId, ffmpegCurrent, code, signal });
    if (ffmpegCurrent) reconnectStream();
  });
  ffmpeg.on("close", (code, signal) => {
    logCameraDiagnostic("ffmpeg.close", {
      attemptId,
      ffmpegCurrent: ffmpeg === processForStream,
      code,
      signal,
      stderrTail: sanitizeCameraDiagnostic(stderrTail).slice(-1024),
    });
  });
}

function reconnectStream() {
  if (!desiredUrl || reconnectTimer) {
    logCameraDiagnostic("retry.skipped", {
      attemptId: ffmpegAttemptId,
      reason: !desiredUrl ? "no_desired_url" : "timer_already_exists",
      ffmpegCurrent: Boolean(ffmpeg),
      retryTimerActive: reconnectTimerActive,
    });
    return;
  }
  clearTimeout(streamWatchdog);
  stopDetection(true);
  const previous = ffmpeg;
  const previousAttemptId = ffmpegAttemptId;
  const previousState = status.state;
  ffmpeg = null;
  previous?.kill();
  const stderrSummary = sanitizeCameraDiagnostic(ffmpegStderrTail).trim();
  status = {
    state: "reconnecting",
    message: "Camera unavailable. Retrying in 5 seconds…" +
      (stderrSummary ? ` Last FFmpeg output: ${stderrSummary.slice(-300)}` : ""),
    connectedAt: null,
    lastFrameAt: null,
  };
  logCameraStateTransition(previousState, status.state, previousAttemptId, false, Boolean(previous));
  logCameraDiagnostic("retry.scheduled", {
    attemptId: previousAttemptId,
    delayMs: 5000,
    ffmpegCurrent: false,
    ffmpegWasCurrent: Boolean(previous),
  });
  reconnectAttemptId = previousAttemptId;
  reconnectTimerActive = true;
  reconnectTimer = setTimeout(() => {
    const url = desiredUrl;
    reconnectTimer = null;
    reconnectAttemptId = null;
    reconnectTimerActive = false;
    logCameraDiagnostic("retry.fired", {
      attemptId: previousAttemptId,
      currentAttemptId: ffmpegAttemptId,
      hasDesiredUrl: Boolean(url),
      belongsToCurrentAttempt: previousAttemptId === ffmpegAttemptId,
    });
    if (url) startStream(url);
  }, 5000);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16000) throw Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function serveMedia(request, response, id, name) {
  if (!['clip.mp4', 'snapshot_pickup.jpg', 'snapshot_disappear.jpg'].includes(name)) return writeJson(response, 404, { error: 'Unknown media' });
  let file, size;
  try { file = path.join(evidence.folder(id), name); size = fs.statSync(file).size; }
  catch { return writeJson(response, 404, { error: 'Media not available yet' }); }
  let start = 0, end = size-1, code = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, size-Number(match[2]));
    end = match[1] && match[2] ? Math.min(size-1, Number(match[2])) : size-1;
    if (start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); return response.end(); }
    code = 206;
  }
  const headers = { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, 'Cache-Control': 'no-store' };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (new URL(request.url, 'http://localhost').searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${id}-${name}"`;
  response.writeHead(code, headers);
  if (request.method === 'HEAD') return response.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function serveStatic(request, response) {
  const requestPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return writeJson(response, 403, { error: "Forbidden" });
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
  fs.readFile(filePath, (error, data) => {
    if (error) return writeJson(response, 404, { error: "Not found" });
    response.writeHead(200, { "Content-Type": `${types[path.extname(filePath)] || "application/octet-stream"}; charset=utf-8` });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  // Local page only; reject cross-origin state-changing browser requests.
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return writeJson(response, 403, { error: 'Origin not allowed' });
  const pathname = request.url.split("?")[0];
  if (pathname === '/api/alerts' && request.method === 'GET') return writeJson(response, 200, { alerts: evidence.list(), warning: evidence.error });
  const media = /^\/api\/alerts\/([\w-]+)\/media\/([\w.]+)$/.exec(pathname);
  if (media && ['GET', 'HEAD'].includes(request.method)) return serveMedia(request, response, media[1], media[2]);
  const review = /^\/api\/alerts\/([\w-]+)\/review$/.exec(pathname);
  if (review && request.method === 'POST') {
    try { const body = await readBody(request); return writeJson(response, 200, evidence.review(review[1], body.review, body.notes)); }
    catch (error) { return writeJson(response, 400, { error: error.message }); }
  }
  if (pathname === '/api/alerts/manual' && request.method === 'POST') {
    if (status.state !== 'connected' || !currentFrame) return writeJson(response, 409, { error: 'Connect a live camera first' });
    const id = evidence.begin({ source: 'manual', headline: 'Manually saved review clip', reason: 'Saved by the operator; no automatic concealment detection.' }, currentFrame);
    return writeJson(response, 201, { id });
  }
  if (pathname === "/api/config" && request.method === "GET") {
    const config = readConfig();
    return writeJson(response, 200, { rtspUrl: publicRtspUrl(config.rtspUrl) });
  }

  if (pathname === "/api/status" && request.method === "GET") {
    const attendanceWindowActive = isAttendanceWindowActive(
      new Date(),
      attendanceConfig.attendanceStartTime,
      attendanceConfig.attendanceEndTime,
    );
    return writeJson(response, 200, {
      ...status,
      detection,
      attendanceEnabled,
      recognitionRuntime,
      recognitionOnlyMode,
      livenessEnabled,
      attendanceStartTime: attendanceConfig.attendanceStartTime,
      attendanceEndTime: attendanceConfig.attendanceEndTime,
      attendanceWindowActive,
      attendanceRecordingAllowed: attendanceEnabled && attendanceWindowActive,
      genericEnabled,
      faceStateEnabled,
    });
  }

  if (pathname === "/api/attendance/records" && request.method === "GET") {
    return writeJson(response, 200, { records: attendanceStore.list(), error: attendanceError });
  }

  if (pathname === "/api/roles" && request.method === "GET") {
    return writeJson(response, 200, { roles });
  }
  if (pathname === "/api/roles" && request.method === "POST") {
    try {
      const body = await readBody(request);
      roles = normalizeRoles(body.roles);
      fs.writeFileSync(ROLES_FILE, JSON.stringify({ roles }, null, 2));
      if (detector && detectorReady) sendRoles(detector);
      return writeJson(response, 200, { roles });
    } catch (error) {
      return writeJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/generic" && request.method === "POST") {
    try {
      const body = await readBody(request);
      genericEnabled = body.enabled === true;
      fs.writeFileSync(GENERIC_FILE, JSON.stringify({ enabled: genericEnabled }, null, 2));
      if (detector && detectorReady) sendLine(detector, { generic: genericEnabled });
      return writeJson(response, 200, { enabled: genericEnabled });
    } catch (error) {
      return writeJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/facestate" && request.method === "POST") {
    try {
      const body = await readBody(request);
      faceStateEnabled = body.enabled === true;
      fs.writeFileSync(FACESTATE_FILE, JSON.stringify({ enabled: faceStateEnabled }, null, 2));
      if (detector && detectorReady) sendLine(detector, { faceState: faceStateEnabled });
      return writeJson(response, 200, { enabled: faceStateEnabled });
    } catch (error) {
      return writeJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/attendance" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const hasEnabled = typeof body.enabled === 'boolean';
      const hasLiveness = typeof body.livenessEnabled === 'boolean';
      const hasStart = Object.hasOwn(body, 'attendanceStartTime');
      const hasEnd = Object.hasOwn(body, 'attendanceEndTime');
      if (hasStart && !isValidAttendanceTime(body.attendanceStartTime)) {
        return writeJson(response, 400, { error: 'attendanceStartTime must use 24-hour HH:mm format' });
      }
      if (hasEnd && !isValidAttendanceTime(body.attendanceEndTime)) {
        return writeJson(response, 400, { error: 'attendanceEndTime must use 24-hour HH:mm format' });
      }
      if (!hasEnabled && !hasLiveness && !hasStart && !hasEnd) {
        return writeJson(response, 400, {
          error: 'Provide enabled, livenessEnabled, attendanceStartTime, or attendanceEndTime',
        });
      }
      const nextEnabled = hasEnabled ? body.enabled : attendanceEnabled;
      const nextLivenessEnabled = hasLiveness ? body.livenessEnabled : livenessEnabled;
      if (recognitionOnlyMode && (nextEnabled || nextLivenessEnabled)) {
        return writeJson(response, 409, {
          error: "Attendance and liveness settings cannot be enabled in recognition-only mode.",
        });
      }
      const proposedStart = hasStart
        ? body.attendanceStartTime
        : attendanceConfig.attendanceStartTime;
      const proposedEnd = hasEnd
        ? body.attendanceEndTime
        : attendanceConfig.attendanceEndTime;
      if (proposedStart >= proposedEnd) {
        return writeJson(response, 400, { error: 'Attendance start time must be earlier than end time' });
      }
      const schedule = normalizeAttendanceSchedule(proposedStart, proposedEnd);
      const nextConfig = {
        enabled: nextEnabled,
        livenessEnabled: nextLivenessEnabled,
        ...schedule,
      };
      fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(nextConfig, null, 2));
      attendanceEnabled = nextEnabled;
      livenessEnabled = nextLivenessEnabled;
      attendanceConfig = nextConfig;
      if (!recognitionOnlyMode) {
        recognitionRuntime = attendanceEnabled
          ? { state: detector && detectorReady ? "initializing" : "stopped",
              message: detector && detectorReady
                ? "Enabled in settings; initializing face recognition."
                : "Enabled in settings; detection is not running." }
          : { state: "disabled", message: "Face recognition is disabled in settings." };
      }
      if (detector && detectorReady) {
        if (typeof body.enabled === 'boolean') sendLine(detector, { attendance: attendanceEnabled });
        if (typeof body.livenessEnabled === 'boolean') sendLine(detector, { livenessEnabled });
      }
      return writeJson(response, 200, nextConfig);
    } catch (error) {
      return writeJson(response, 400, { error: error.message });
    }
  }
  if (pathname === "/api/attendance/enroll" && request.method === "POST") {
    if (!canEnrollFaces(recognitionOnlyMode)) {
      return writeJson(response, 409, {
        error: "Enrollment is disabled in recognition-only mode.",
      });
    }
    try {
      const body = await readBody(request);
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return writeJson(response, 400, { error: "Enter a name for the face" });
      if (!detector || !detectorReady) return writeJson(response, 409, { error: "Start detection first, then enroll" });
      sendLine(detector, { enroll: name });
      return writeJson(response, 202, { ok: true, name });
    } catch (error) {
      return writeJson(response, 400, { error: error.message });
    }
  }

  if (pathname === "/api/detection/start" && request.method === "POST") {
    if (status.state !== "connected") return writeJson(response, 409, { error: "Connect the camera first" });
    try {
      if (!detector) startDetection();
      return writeJson(response, 202, detection);
    } catch {
      stopDetection();
      return writeJson(response, 500, { error: "Unable to start detection" });
    }
  }
  if (pathname === "/api/detection/stop" && request.method === "POST") {
    stopDetection();
    return writeJson(response, 200, detection);
  }

  if (pathname === "/api/connect" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) request.destroy();
    });
    request.on("end", () => {
      try {
        const submitted = JSON.parse(body);
        const saved = readConfig().rtspUrl;
        const rtspUrl = safeRtspUrl(submitted.rtspUrl === publicRtspUrl(saved) ? saved : submitted.rtspUrl);
        if (!rtspUrl) return writeJson(response, 400, { error: "Enter a valid rtsp:// address" });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ rtspUrl }, null, 2));
        startStream(rtspUrl);
        return writeJson(response, 202, { ok: true, rtspUrl: publicRtspUrl(rtspUrl) });
      } catch (error) {
        const previousState = status.state;
        const message = sanitizeCameraDiagnostic(
          error instanceof Error ? error.message : "Unable to start the camera stream",
        ).slice(0, 300);
        status = {
          state: "error",
          message,
          connectedAt: null,
          lastFrameAt: null,
        };
        logCameraStateTransition(previousState, status.state, ffmpegAttemptId, Boolean(ffmpeg));
        logCameraDiagnostic("connect.failed", {
          attemptId: ffmpegAttemptId,
          ffmpegCurrent: Boolean(ffmpeg),
          error: message,
        });
        return writeJson(response, 400, { error: status.message });
      }
    });
    return;
  }

  if (pathname === "/api/disconnect" && request.method === "POST") {
    stopStream();
    return writeJson(response, 200, { ok: true });
  }

  if (pathname === "/api/stream" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  serveStatic(request, response);
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = typeof error?.code === "string" || typeof error?.code === "number"
    ? error.code
    : undefined;
  logCameraDiagnostic(origin === "unhandledRejection"
    ? "process.unhandled_rejection_fatal"
    : "process.uncaught_exception", {
    origin,
    errorName,
    errorCode,
    errorMessage: sanitizeCameraDiagnostic(errorMessage).slice(0, 300),
  });
});

process.on("exit", (code) => {
  logCameraDiagnostic("process.exit", { code });
});

async function shutdown(signal) {
  logCameraDiagnostic("shutdown.entered", { signal });
  stopStream();
  for (const client of clients) client.end();
  await evidence.close();
  server.close(() => {
    logCameraDiagnostic("shutdown.completed", { signal });
    process.exit(0);
  });
}
process.on("SIGINT", () => {
  logCameraDiagnostic("signal.received", { signal: "SIGINT" });
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  logCameraDiagnostic("signal.received", { signal: "SIGTERM" });
  shutdown("SIGTERM");
});

server.listen(PORT, HOST, () => {
  console.log(`Camera Control running at http://${HOST}:${PORT}`);
});
