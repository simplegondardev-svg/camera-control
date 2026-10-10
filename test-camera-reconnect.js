const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const recognitionRuntime = require('./recognition-runtime');
const recognitionMode = require('./recognition-mode');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const sourceWithTestAccess = `${serverSource}
globalThis.__testApi = {
  startStream,
  stopStream,
  reconnectStream,
  getState: () => ({
    ffmpeg,
    ffmpegAttemptId,
    reconnectTimer,
    reconnectTimerActive,
    desiredUrl,
    status,
  }),
};`;

function createHarness() {
  const children = [];
  const timers = [];
  const logs = [];
  const clearTimeout = handle => {
    if (handle) handle.active = false;
  };
  const setTimeout = (callback, delay) => {
    const handle = { callback, delay, active: true };
    timers.push(handle);
    return handle;
  };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls += 1;
      return true;
    };
    children.push(child);
    return child;
  };
  const server = new EventEmitter();
  server.listen = () => server;
  server.close = callback => callback?.();
  const evidence = {
    addFrame() {},
    begin() {},
    close: async () => {},
    error: null,
    finishPending() {},
    folder() {},
    list: () => [],
    resetBuffer() {},
  };
  class EvidenceStore {
    constructor() {
      return evidence;
    }
  }
  class AttendanceStore {
    list() { return []; }
    observe() {}
  }
  const attendance = {
    AttendanceStore,
    DEFAULT_ATTENDANCE_END_TIME: '22:00',
    DEFAULT_ATTENDANCE_START_TIME: '06:00',
    isAttendanceWindowActive: () => false,
    isValidAttendanceTime: () => true,
    normalizeAttendanceSchedule: () => ({
      attendanceStartTime: '06:00',
      attendanceEndTime: '22:00',
    }),
  };
  const fsStub = {
    readFileSync() { throw new Error('Test harness does not read configuration files'); },
    writeFileSync() { throw new Error('Test harness must not write files'); },
  };
  const httpStub = { createServer: () => server };
  const readlineStub = { createInterface: () => new EventEmitter() };
  const childProcessStub = { spawn };
  const requireStub = name => {
    if (name === 'node:http') return httpStub;
    if (name === 'node:fs') return fsStub;
    if (name === 'node:path') return path;
    if (name === 'node:child_process') return childProcessStub;
    if (name === 'node:readline') return readlineStub;
    if (name === './evidence') return { EvidenceStore };
    if (name === './attendance') return attendance;
    if (name === './recognition-runtime') return recognitionRuntime;
    if (name === './recognition-mode') return recognitionMode;
    throw new Error(`Unexpected module requested by server harness: ${name}`);
  };
  const context = {
    Buffer,
    clearTimeout,
    console: {
      info(line) { logs.push(JSON.parse(line)); },
      error() {},
      log() {},
    },
    process: {
      env: {},
      exit() {},
      on() {},
    },
    require: requireStub,
    setTimeout,
    __dirname,
  };
  vm.runInNewContext(sourceWithTestAccess, context, { filename: 'server.js' });
  return {
    api: context.__testApi,
    children,
    logs,
    timers,
    runTimer(handle) {
      assert.equal(handle.active, true, 'timer should still be active before firing');
      handle.active = false;
      handle.callback();
    },
  };
}

function emitCurrentChildExit(harness) {
  const child = harness.api.getState().ffmpeg;
  assert(child, 'there should be a current FFmpeg child');
  child.emit('exit', 1, null);
  return child;
}

function activeRetryTimers(harness) {
  return harness.timers.filter(timer => timer.active && timer.delay === 5000);
}

function assertRetryScheduled(harness) {
  assert.equal(activeRetryTimers(harness).length, 1);
  assert.equal(harness.api.getState().reconnectTimerActive, true);
}

function testCanceledRetryCanBeFollowedByANewStreamFailure() {
  const harness = createHarness();
  harness.api.startStream('rtsp://127.0.0.1:8554/first');
  emitCurrentChildExit(harness);
  const canceledRetry = harness.api.getState().reconnectTimer;
  assertRetryScheduled(harness);

  harness.api.stopStream();
  assert.equal(canceledRetry.active, false);
  assert.equal(harness.api.getState().reconnectTimer, null);
  assert.equal(harness.api.getState().reconnectTimerActive, false);

  harness.api.startStream('rtsp://127.0.0.1:8554/second');
  emitCurrentChildExit(harness);
  assertRetryScheduled(harness);
  assert.equal(harness.api.getState().desiredUrl, 'rtsp://127.0.0.1:8554/second');
}

function testManualDisconnectReconnectCanRetryAfterFailure() {
  const harness = createHarness();
  harness.api.startStream('rtsp://127.0.0.1:8554/camera');
  emitCurrentChildExit(harness);
  const canceledRetry = harness.api.getState().reconnectTimer;

  harness.api.stopStream('Stream disconnected');
  assert.equal(canceledRetry.active, false);
  assert.equal(harness.api.getState().reconnectTimer, null);

  harness.api.startStream('rtsp://127.0.0.1:8554/camera');
  emitCurrentChildExit(harness);
  assertRetryScheduled(harness);
}

function testActiveRetryPreventsDuplicateScheduling() {
  const harness = createHarness();
  harness.api.startStream('rtsp://127.0.0.1:8554/camera');
  emitCurrentChildExit(harness);
  harness.api.reconnectStream();

  assertRetryScheduled(harness);
  const skipped = harness.logs.findLast(log => log.event === 'retry.skipped');
  assert.equal(skipped.reason, 'timer_already_exists');
  assert.equal(skipped.retryTimerActive, true);
}

function testFiredRetryClearsHandleAndAllowsFollowingRetry() {
  const harness = createHarness();
  harness.api.startStream('rtsp://127.0.0.1:8554/camera');
  emitCurrentChildExit(harness);
  const firstRetry = harness.api.getState().reconnectTimer;

  harness.runTimer(firstRetry);
  assert.equal(harness.api.getState().reconnectTimer, null);
  assert.equal(harness.api.getState().reconnectTimerActive, false);
  assert.equal(harness.children.length, 2);

  emitCurrentChildExit(harness);
  assertRetryScheduled(harness);
}

function testDiagnosticsDistinguishCancellationFromActiveRetry() {
  const harness = createHarness();
  harness.api.startStream('rtsp://127.0.0.1:8554/camera');
  emitCurrentChildExit(harness);
  harness.api.reconnectStream();

  const activeSkip = harness.logs.findLast(log => log.event === 'retry.skipped');
  assert.equal(activeSkip.retryTimerActive, true);

  const retry = harness.api.getState().reconnectTimer;
  harness.api.stopStream();
  const cancelled = harness.logs.findLast(log => log.event === 'retry.cancelled');
  assert.equal(cancelled.reason, 'stream_stopped');
  assert.equal(retry.active, false);
  assert.equal(harness.api.getState().reconnectTimer, null);

  harness.api.startStream('rtsp://127.0.0.1:8554/new');
  emitCurrentChildExit(harness);
  assertRetryScheduled(harness);
  assert.equal(harness.logs.some(log =>
    log.event === 'retry.skipped' &&
    log.reason === 'timer_already_exists' &&
    log.retryTimerActive === false), false);
}

const tests = [
  ['canceled retry followed by new stream failure', testCanceledRetryCanBeFollowedByANewStreamFailure],
  ['manual disconnect and reconnect followed by failure', testManualDisconnectReconnectCanRetryAfterFailure],
  ['active retry prevents duplicate scheduling', testActiveRetryPreventsDuplicateScheduling],
  ['fired retry clears handle and allows another retry', testFiredRetryClearsHandleAndAllowsFollowingRetry],
  ['diagnostics distinguish active timer from canceled timer', testDiagnosticsDistinguishCancellationFromActiveRetry],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS: ${name}`);
}
