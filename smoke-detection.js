// Requires a running local server and connected phone. Automatic events may save review clips.
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4173';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  assert(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
async function waitFor(predicate, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = await api('/api/status');
    if (predicate(state)) return state;
    assert(state.detection.state !== 'error', state.detection.message);
    await delay(500);
  }
  throw Error('Timed out waiting for live detection');
}
async function main() {
  const initial = await api('/api/status');
  assert.equal(initial.state, 'connected', 'Connect camera before testing');
  await api('/api/detection/start', 'POST');
  const first = await waitFor(state => Boolean(state.detection.updatedAt));
  assert(Number.isFinite(first.detection.inferenceMs));
  const response = await fetch(base + '/api/stream?t=smoke', { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const reader = response.body.getReader();
  const frame = await reader.read();
  assert(frame.value.length > 0);
  await reader.cancel();
  console.log('Detection result:', JSON.stringify(first.detection));
  await api('/api/detection/stop', 'POST');
  const stopped = await api('/api/status');
  assert.equal(stopped.detection.state, 'off');
  assert.equal(stopped.state, 'connected');
  await api('/api/detection/start', 'POST');
  await waitFor(state => Boolean(state.detection.updatedAt));
  console.log('PASS: annotated stream, stop, and restart');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
