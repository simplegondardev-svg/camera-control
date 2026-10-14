function isRecognitionOnlyMode(env) {
  return env.CAMERA_RECOGNITION_ONLY === "1";
}

function validateRecognitionOnlySettings(enabled, attendanceEnabled, livenessEnabled) {
  if (enabled && (attendanceEnabled || livenessEnabled)) {
    throw new Error(
      "Recognition-only mode requires attendance and liveness to be disabled in settings.",
    );
  }
}

function shouldRecordAttendance(attendanceEnabled, recognitionOnlyMode) {
  return attendanceEnabled && !recognitionOnlyMode;
}

function canEnrollFaces(recognitionOnlyMode) {
  return !recognitionOnlyMode;
}

function recordAttendanceIfAllowed(attendanceEnabled, recognitionOnlyMode, record) {
  if (!shouldRecordAttendance(attendanceEnabled, recognitionOnlyMode)) return false;
  record();
  return true;
}

module.exports = {
  isRecognitionOnlyMode,
  canEnrollFaces,
  recordAttendanceIfAllowed,
  shouldRecordAttendance,
  validateRecognitionOnlySettings,
};
