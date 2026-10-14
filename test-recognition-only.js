const assert = require('node:assert/strict');
const {
  canEnrollFaces,
  isRecognitionOnlyMode,
  recordAttendanceIfAllowed,
  validateRecognitionOnlySettings,
} = require('./recognition-mode');

assert.equal(isRecognitionOnlyMode({ CAMERA_RECOGNITION_ONLY: '1' }), true);
assert.equal(isRecognitionOnlyMode({ CAMERA_RECOGNITION_ONLY: 'true' }), false);
assert.equal(canEnrollFaces(true), false);
assert.equal(canEnrollFaces(false), true);
assert.doesNotThrow(() => validateRecognitionOnlySettings(true, false, false));
assert.throws(
  () => validateRecognitionOnlySettings(true, true, false),
  /requires attendance and liveness to be disabled/,
);
assert.throws(
  () => validateRecognitionOnlySettings(true, false, true),
  /requires attendance and liveness to be disabled/,
);

let attendanceWrites = 0;
const noWrite = recordAttendanceIfAllowed(true, true, () => attendanceWrites++);
assert.equal(noWrite, false);
assert.equal(attendanceWrites, 0);

const recorded = recordAttendanceIfAllowed(true, false, () => attendanceWrites++);
assert.equal(recorded, true);
assert.equal(attendanceWrites, 1);

console.log('PASS: recognition-only mode fails closed and suppresses attendance writes.');
