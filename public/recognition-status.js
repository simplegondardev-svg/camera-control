function formatRecognitionStatus(status) {
  const enabled = status.attendanceEnabled === true;
  const recognitionOnly = status.recognitionOnlyMode === true;
  const runtime = status.recognitionRuntime || {};
  const messages = {
    disabled: 'Face recognition is disabled in settings.',
    initializing: 'Face recognition is initializing.',
    ready: 'Face recognition is ready.',
    stopped: 'Detection is not running; recognition is unavailable.',
    unavailable: 'Face recognition unavailable: ' +
      (runtime.message || 'Initialization failed.'),
  };
  if (recognitionOnly) {
    messages.initializing = 'Recognition-only test mode is initializing.';
    messages.ready = 'Recognition-only test mode ready; attendance and liveness are disabled.';
    messages.stopped = 'Recognition-only test mode active; detection is not running.';
    messages.unavailable = 'Recognition-only test mode unavailable: ' +
      (runtime.message || 'Initialization failed.');
  }
  return {
    enabled,
    enrollmentAvailable: !recognitionOnly,
    enrollmentMessage: recognitionOnly
      ? 'Enrollment is unavailable in recognition-only mode. Existing enrolled identities can still be recognized.'
      : '',
    settingsMessage: recognitionOnly
      ? 'Attendance recording is disabled in settings; recognition-only test mode is active.'
      : enabled
        ? 'Face recognition enabled in settings.'
        : 'Face recognition disabled in settings.',
    runtimeMessage: messages[runtime.state] || messages.unavailable,
  };
}

if (typeof module !== 'undefined') module.exports = formatRecognitionStatus;
