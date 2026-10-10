function formatFaceStateStatus(analysis, stale) {
  if (!analysis.faceStateOn || stale) return '';
  if (analysis.faceStateError) {
    return 'Face processing unavailable: ' + analysis.faceStateError;
  }
  const states = analysis.faceStates;
  if (!states) return '';
  return 'Face states — ' + ['smiling', 'frowning', 'mouthOpen', 'eyesClosed', 'lookingAway']
    .filter(key => states[key])
    .map(key => key.replace(/([A-Z])/g, ' $1').toLowerCase() + ': ' + states[key])
    .join(', ') + (Object.values(states).some(Boolean) ? '' : 'no faces in view');
}

if (typeof module !== 'undefined') module.exports = formatFaceStateStatus;
