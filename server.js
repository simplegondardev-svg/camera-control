const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { EvidenceStore } = require('./evidence');
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
const DEFAULT_URL = "rtsp://192.168.1.2:8554";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const evidence = new EvidenceStore(process.env.CAMERA_DATA_DIR || path.join(__dirname, 'clips'), FFMPEG);
const attendanceStore = new AttendanceStore(path.join(__dirname, 'attendance-records.json'));

const clients = new Set();
let ffmpeg = null;
let jpegBuffer = Buffer.alloc(0);
let detector = null;
let detectorReady = false;
let detectorBusy = false;
let detectionTimer = null;
let detection = { state: "off", message: "Detection is off" };
let currentFrame = null;
let analyzedFrame = null;
let reconnectTimer = null;
let streamWatchdog = null;
let desiredUrl = null;
let wantsDetection = false;
let roles = readRoles();
let attendanceConfig = readAttendanceConfig();
let attendanceEnabled = attendanceConfig.enabled;
let livenessEnabled = attendanceConfig.livenessEnabled;
let genericEnabled = readGeneric();
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
}

function startDetection() {
  stopDetection(true);
  wantsDetection = true;
  detection = { state: "loading", message: "Loading detection models…" };
  const worker = spawn(path.join(__dirname, ".venv/Scripts/python.exe"), ["-u", path.join(__dirname, "detection.py")], { cwd: __dirname, windowsHide: true });
  let frameErrors = 0;
  detector = worker;
  const fail = () => {
    if (detector !== worker) return;
    stopDetection();
    detection = { state: "error", message: "Detection stopped. Check Python dependencies and model files, then retry." };
  };
  detectionTimer = setTimeout(fail, 60000);
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.stdin.on("error", fail);
  worker.stderr.on("data", () => {});
  readline.createInterface({ input: worker.stdout }).on("line", line => {
    if (detector !== worker) return;
    let result;
    try { result = JSON.parse(line); } catch { return; }
    if (result.type === "ready") {
      clearTimeout(detectionTimer);
      detectorReady = true;
      sendRoles(worker);
      sendLine(worker, { attendance: attendanceEnabled });
      sendLine(worker, { livenessEnabled });
      sendLine(worker, { generic: genericEnabled });
      detection = { state: "running", message: "Waiting for a camera frame" };
    } else if (result.type === "frame") {
      clearTimeout(detectionTimer);
      detectorBusy = false;
      frameErrors = 0;
      const { frame, type, events = [], enrolled, ...metrics } = result;
      if (attendanceEnabled) {
        try {
          attendanceStore.observe(metrics.faces, {
            livenessEnabled,
            attendanceStartTime: attendanceConfig.attendanceStartTime,
            attendanceEndTime: attendanceConfig.attendanceEndTime,
          });
          attendanceError = null;
        } catch (error) {
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

function stopStream(message = "Stream disconnected") {
  desiredUrl = null;
  clearTimeout(reconnectTimer);
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
}

function broadcastFrame(frame) {
  currentFrame = frame;
  evidence.addFrame(frame);
  clearTimeout(streamWatchdog);
  streamWatchdog = setTimeout(reconnectStream, 15000);
  status.lastFrameAt = new Date().toISOString();
  if (status.state !== "connected") {
    status.state = "connected";
    status.message = "Live stream connected";
    status.connectedAt = status.lastFrameAt;
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
  desiredUrl = rtspUrl;
  streamWatchdog = setTimeout(reconnectStream, 20000);
  status = { state: "connecting", message: "Opening camera stream…", connectedAt: null, lastFrameAt: null };

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

  const processForStream = ffmpeg;
  ffmpeg.stdout.on("data", chunk => { if (ffmpeg === processForStream) extractFrames(chunk); });
  ffmpeg.stderr.on("data", (chunk) => {
    if (ffmpeg !== processForStream) return;
    const line = chunk.toString().trim().split(/\r?\n/).at(-1);
    if (line && status.state !== "connected") status.message = line.slice(0, 180);
  });
  ffmpeg.on("error", (error) => {
    if (ffmpeg !== processForStream) return;
    reconnectStream();
  });
  ffmpeg.on("exit", (code) => {
    if (ffmpeg === processForStream) {
      reconnectStream();
    }
  });
}

function reconnectStream() {
  if (!desiredUrl || reconnectTimer) return;
  clearTimeout(streamWatchdog);
  stopDetection(true);
  const previous = ffmpeg;
  ffmpeg = null;
  previous?.kill();
  status = { state: 'reconnecting', message: 'Camera unavailable. Retrying in 5 seconds…', connectedAt: null, lastFrameAt: null };
  reconnectTimer = setTimeout(() => { const url = desiredUrl; reconnectTimer = null; if (url) startStream(url); }, 5000);
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
      livenessEnabled,
      attendanceStartTime: attendanceConfig.attendanceStartTime,
      attendanceEndTime: attendanceConfig.attendanceEndTime,
      attendanceWindowActive,
      attendanceRecordingAllowed: attendanceEnabled && attendanceWindowActive,
      genericEnabled,
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
        status = {
          state: "error",
          message: error instanceof Error ? error.message : "Unable to start the camera stream",
          connectedAt: null,
          lastFrameAt: null,
        };
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

async function shutdown() {
  stopStream();
  for (const client of clients) client.end();
  await evidence.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Camera Control running at http://${HOST}:${PORT}`);
});
