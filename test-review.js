// End-to-end review checks use temporary evidence, never the user's saved clips.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EvidenceStore } = require('./evidence');
const { chromium } = require('playwright-core');
const ffmpeg = 'C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-review-test-'));
const image = fs.readFileSync(path.join(__dirname, '.venv/Lib/site-packages/ultralytics/assets/bus.jpg'));
const base = 'http://127.0.0.1:4189';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, store;
async function api(route, method = 'GET', body) {
  const r = await fetch(base+route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  assert(r.ok, route + ': ' + r.status);
  return r.json();
}
async function boot() {
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: '4189', CAMERA_DATA_DIR: root }, windowsHide: true });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw Error('Test server exited');
    try { if ((await fetch(base+'/api/status')).ok) return; } catch {}
    await sleep(200);
  }
  throw Error('Test server did not start');
}
async function main() {
  store = new EvidenceStore(root, ffmpeg);
  const now = Date.now();
  for (let i = 0; i < 20; i++) store.addFrame(image, now-4000+i*200);
  const id = store.begin({ headline: 'Test disappearance review', reason: 'Automated test fixture', object: 'bottle', pickup: image.toString('base64') }, image);
  store.review(id, 'unclear', 'Saved before stopping');
  await store.close(); // Simulates stop during the after-alert window.
  let record = store.list().find(a => a.id === id);
  assert.equal(record.mediaStatus, 'ready');
  assert.equal(record.partial, true);
  assert(record.media['snapshot_pickup.jpg']);
  const probe = JSON.parse(execFileSync(ffmpeg.replace('ffmpeg.exe', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path.join(root,id,'clip.mp4')], { encoding: 'utf8', windowsHide: true }));
  assert.equal(probe.streams[0].codec_name, 'h264');
  // Simulate a process exit before encoding: recover the persisted JPEG journal.
  store = new EvidenceStore(root, ffmpeg);
  store.addFrame(image);
  const recoveredId = store.begin({ headline: 'Recovery fixture', reason: 'Interrupted capture', object: 'cup' }, image);
  clearInterval(store.timer);
  store.pending.clear();
  const recovered = new EvidenceStore(root, ffmpeg);
  await recovered.queue;
  assert.equal(recovered.list().find(a => a.id === recoveredId).mediaStatus, 'ready');
  assert.equal(recovered.list().find(a => a.id === id).review, 'unclear');
  await recovered.close();
  await boot();
  const list = await api('/api/alerts');
  assert.equal(list.alerts.length, 2);
  const mediaUrl = '/api/alerts/'+id+'/media/clip.mp4';
  const range = await fetch(base+mediaUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(base+mediaUrl, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await fetch(base+'/api/alerts/'+id+'/media/event.json')).status, 404);
  assert.equal((await fetch(base+'/api/detection/start', { method: 'POST' })).status, 409);
  assert.equal((await fetch(base+'/api/alerts/'+id+'/review', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({review:'invalid',notes:''}) })).status, 400);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Open review' }).first().waitFor();
  await page.locator('.review-card').filter({ hasText: 'Test disappearance review' }).getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('#reviewVideo').readyState >= 2);
  await page.selectOption('#reviewDecision', 'false_alert');
  await page.fill('#reviewNotes', 'Returned to table - browser test');
  await page.click('#saveReview');
  await page.getByText('Review saved.', { exact: true }).waitFor();
  await page.click('#closeReview');
  await page.reload();
  await page.selectOption('#reviewFilter', 'false_alert');
  await page.waitForFunction(() => document.querySelectorAll('.review-card').length === 1);
  await page.getByRole('button', { name: 'Open review' }).click();
  assert.equal(await page.inputValue('#reviewNotes'), 'Returned to table - browser test');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile horizontal overflow');
  assert.equal(errors.length, 0, errors.join('\n'));
  await browser.close(); browser = null;
  child.kill(); await new Promise(resolve => child.once('exit', resolve)); child = null;
  await boot();
  assert.equal((await api('/api/alerts')).alerts.find(a => a.id === id).notes, 'Returned to table - browser test');
  console.log('PASS: H.264 playback, interrupted capture recovery, snapshots, range seeking, review saves, restart persistence, browser controls and mobile layout.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  if (store) clearInterval(store.timer);
  // This uniquely generated temp directory contains only this test's fixtures.
  fs.rmSync(root, { recursive: true, force: true });
});
