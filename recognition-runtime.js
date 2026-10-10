const MODEL_BASENAMES = new Set([
  "face_detection_yunet_2026may.onnx",
  "face_recognition_sface_2021dec.onnx",
]);

function sanitizeRecognitionRuntime(value) {
  const state = ["disabled", "initializing", "ready", "unavailable", "stopped"].includes(value?.state)
    ? value.state
    : "unavailable";
  if (state === "unavailable") {
    const message = String(value?.message || "").match(
      /^Missing face model: ([A-Za-z0-9_.-]+)$/,
    );
    return {
      state,
      message: message && MODEL_BASENAMES.has(message[1])
        ? message[0]
        : "Face recognition initialization failed.",
    };
  }
  const messages = {
    disabled: "Face recognition is disabled in settings.",
    initializing: "Enabled in settings; initializing face recognition.",
    ready: "Face recognition is ready.",
    stopped: "Enabled in settings; detection is not running.",
  };
  return { state, message: messages[state] };
}

module.exports = { sanitizeRecognitionRuntime };
