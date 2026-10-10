const assert = require('node:assert/strict');
const formatRecognitionStatus = require('./public/recognition-status');
const { sanitizeRecognitionRuntime } = require('./recognition-runtime');

const workerError = {
  state: 'unavailable',
  message: 'Missing face model: face_detection_yunet_2026may.onnx',
};
const sanitized = sanitizeRecognitionRuntime(workerError);
assert.deepEqual(sanitized, workerError);
assert.deepEqual(sanitizeRecognitionRuntime({
  state: 'unavailable',
  message: 'Failed to load C:\\private\\camera\\secret.onnx',
}), {
  state: 'unavailable',
  message: 'Face recognition initialization failed.',
});

const unavailable = formatRecognitionStatus({
  attendanceEnabled: true,
  detection: { attendanceOn: false },
  recognitionRuntime: sanitized,
});

assert.equal(unavailable.enabled, true);
assert.equal(unavailable.settingsMessage, 'Face recognition enabled in settings.');
assert.equal(
  unavailable.runtimeMessage,
  'Face recognition unavailable: Missing face model: face_detection_yunet_2026may.onnx',
);

const ready = formatRecognitionStatus({
  attendanceEnabled: true,
  recognitionRuntime: { state: 'ready' },
});
assert.equal(ready.enabled, true);
assert.equal(ready.runtimeMessage, 'Face recognition is ready.');

const disabled = formatRecognitionStatus({
  attendanceEnabled: false,
  recognitionRuntime: { state: 'disabled' },
});
assert.equal(disabled.enabled, false);
assert.equal(disabled.settingsMessage, 'Face recognition disabled in settings.');
assert.equal(disabled.runtimeMessage, 'Face recognition is disabled in settings.');

const recognitionOnly = formatRecognitionStatus({
  attendanceEnabled: false,
  recognitionOnlyMode: true,
  recognitionRuntime: { state: 'ready' },
});
assert.equal(recognitionOnly.enabled, false);
assert.equal(recognitionOnly.enrollmentAvailable, false);
assert.equal(
  recognitionOnly.enrollmentMessage,
  'Enrollment is unavailable in recognition-only mode. Existing enrolled identities can still be recognized.',
);
assert.equal(
  recognitionOnly.settingsMessage,
  'Attendance recording is disabled in settings; recognition-only test mode is active.',
);
assert.equal(
  recognitionOnly.runtimeMessage,
  'Recognition-only test mode ready; attendance and liveness are disabled.',
);

const recognitionOnlyUnavailable = formatRecognitionStatus({
  attendanceEnabled: false,
  recognitionOnlyMode: true,
  recognitionRuntime: {
    state: 'unavailable',
    message: 'Missing face model: face_recognition_sface_2021dec.onnx',
  },
});
assert.equal(
  recognitionOnlyUnavailable.runtimeMessage,
  'Recognition-only test mode unavailable: Missing face model: face_recognition_sface_2021dec.onnx',
);

assert.equal(disabled.enrollmentAvailable, true);
assert.equal(disabled.enrollmentMessage, '');
assert.equal(ready.enrollmentAvailable, true);

console.log('PASS: UI preserves the configured toggle while distinguishing unavailable runtime state.');
