const assert = require('node:assert/strict');
const formatFaceStateStatus = require('./public/face-state-status');

const base = {
  faceStateOn: true,
  faceStates: {
    smiling: 0,
    frowning: 0,
    mouthOpen: 0,
    eyesClosed: 0,
    lookingAway: 0,
  },
};

assert.equal(
  formatFaceStateStatus({ ...base, faceStateError: 'model initialization failed' }, false),
  'Face processing unavailable: model initialization failed',
);
assert.equal(formatFaceStateStatus(base, false), 'Face states — no faces in view');
assert.equal(
  formatFaceStateStatus({
    ...base,
    faceStateError: null,
    faceStates: { ...base.faceStates, smiling: 1 },
  }, false),
  'Face states — smiling: 1',
);
assert.equal(
  formatFaceStateStatus({ ...base, faceStateError: 'old error' }, true),
  '',
);

console.log('PASS: face-state errors are distinct from empty results and successful status renders normally.');
