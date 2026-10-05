const $ = selector => document.querySelector(selector);
const form = $('#connectionForm'), input = $('#rtspUrl');
const connectButton = $('#connectButton'), disconnectButton = $('#disconnectButton');
const streamImage = $('#streamImage'), viewer = $('#viewer');
const startDetection = $('#startDetection'), stopDetection = $('#stopDetection');
const dialog = $('#reviewDialog'), video = $('#reviewVideo');
const roleForm = $('#roleForm'), roleList = $('#roleList');
const attendanceToggle = $('#attendanceToggle'), enrollForm = $('#enrollForm');
const genericToggle = $('#genericToggle');
let previousState = 'idle', alerts = [], selectedId = null, alertSignature = '';
let cameraAction = false, detectionAction = false, sourceDirty = false;
let roles = [];

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}
const post = (url, body) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function fitCameraFrame() {
  if (streamImage.naturalWidth && streamImage.naturalHeight && !streamImage.hidden) {
    viewer.style.setProperty('--stream-ratio', streamImage.naturalWidth / streamImage.naturalHeight);
    $('#streamMeta').textContent = streamImage.naturalWidth + ' × ' + streamImage.naturalHeight + ' · Full frame';
  }
}
streamImage.addEventListener('load', fitCameraFrame);
streamImage.addEventListener('error', () => {
  if (previousState === 'connected') {
    streamImage.hidden = true;
    $('#diagnosticMessage').textContent = 'Preview interrupted. Reconnecting…';
    previousState = 'preview_error';
  }
});

function renderStatus(status) {
  const analysis = status.detection || { state: 'off', message: 'Detection is off' };
  const active = ['loading', 'running'].includes(analysis.state);
  startDetection.disabled = detectionAction || status.state !== 'connected' || active;
  stopDetection.disabled = detectionAction || !active;
  const stale = analysis.updatedAt && Date.now()-Date.parse(analysis.updatedAt) > 5000;
  $('#detectionStatus').textContent = stale ? 'Waiting for fresh analysis…' : analysis.message;
  $('#detectionMetrics').textContent = analysis.updatedAt && !stale
    ? analysis.people + ' now · peak ' + (analysis.peoplePeak || 0) + ' · ' + (analysis.uniquePeople || 0) + ' seen · ' +
      analysis.objects + ' objects · ' + analysis.wrists + ' wrists · ' + (analysis.inHand || 0) + ' in hand' +
      (analysis.genericObjects ? ' (+' + analysis.genericObjects + ' unnamed)' : '') + ' · ' +
      analysis.inferenceMs + ' ms/frame. In hand: ' + ((analysis.nearby || []).join(', ') || 'none') + '.' +
      ((analysis.groups && analysis.groups.length)
        ? ' Together: ' + analysis.groups.map(g => g.map(id => '#' + id).join('+')).join(', ') + '.'
        : '') +
      (analysis.roleCounts && Object.values(analysis.roleCounts).some(Boolean)
        ? ' Roles: ' + Object.entries(analysis.roleCounts).filter(([, n]) => n).map(([n, c]) => n + ' ' + c).join(', ') + '.'
        : '')
    : '';
  const labels = { idle: 'Not connected', connecting: 'Connecting', reconnecting: 'Reconnecting', connected: 'Live', error: 'Connection error' };
  $('#statusChip').dataset.state = status.state;
  $('#statusLabel').textContent = labels[status.state] || status.state;
  $('#diagnosticTitle').textContent = labels[status.state] || 'Camera status';
  $('#diagnosticMessage').textContent = status.message;
  $('#diagnosticIcon').textContent = status.state === 'connected' ? '✓' : status.state === 'error' ? '!' : 'i';
  connectButton.disabled = cameraAction;
  disconnectButton.disabled = cameraAction || status.state === 'idle';
  $('#saveClip').disabled = status.state !== 'connected';
  if (status.state === 'connected') {
    if (previousState !== 'connected') streamImage.src = '/api/stream?t=' + Date.now();
    streamImage.hidden = false;
    $('#emptyState').hidden = true;
    fitCameraFrame();
  } else {
    streamImage.hidden = true;
    streamImage.removeAttribute('src');
    $('#emptyState').hidden = false;
    $('#streamMeta').textContent = 'Awaiting stream';
  }
  previousState = status.state;
  renderAttendance(status);
}

input.addEventListener('input', () => { sourceDirty = true; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  cameraAction = true;
  connectButton.disabled = true;
  try {
    const config = await post('/api/connect', { rtspUrl: input.value.trim() });
    input.value = config.rtspUrl;
    sourceDirty = false;
  } catch (error) { $('#diagnosticMessage').textContent = error.message; }
  finally { cameraAction = false; connectButton.disabled = false; }
});
disconnectButton.addEventListener('click', async () => {
  cameraAction = true;
  try { await post('/api/disconnect'); renderStatus(await fetchJson('/api/status')); }
  catch (error) { $('#diagnosticMessage').textContent = error.message; }
  finally { cameraAction = false; }
});
for (const [button, action] of [[startDetection, 'start'], [stopDetection, 'stop']]) {
  button.addEventListener('click', async () => {
    detectionAction = true;
    button.disabled = true;
    try { await post('/api/detection/' + action); }
    catch (error) { $('#detectionStatus').textContent = error.message; }
    finally { detectionAction = false; }
  });
}

function renderRoles() {
  roleList.replaceChildren(...roles.map((role, index) => {
    const swatch = document.createElement('span');
    swatch.className = 'role-swatch';
    swatch.style.background = role.color;
    const name = textElement('span', role.name);
    name.className = 'role-name';
    const remove = textElement('button', 'Remove');
    remove.className = 'link-button';
    remove.type = 'button';
    remove.addEventListener('click', () => { roles.splice(index, 1); saveRoles(); });
    const item = document.createElement('li');
    item.append(swatch, name, remove);
    return item;
  }));
}
async function saveRoles() {
  try {
    const result = await post('/api/roles', { roles });
    roles = result.roles;
    $('#roleStatus').textContent = roles.length ? 'Saved. Labels apply while detection runs.' : 'No roles set.';
  } catch (error) { $('#roleStatus').textContent = error.message; }
  renderRoles();
}
roleForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#roleName').value.trim();
  if (!name) return;
  roles.push({ name, color: $('#roleColor').value });
  $('#roleName').value = '';
  saveRoles();
});
fetchJson('/api/roles').then(result => { roles = result.roles; renderRoles(); }).catch(() => {});

genericToggle.addEventListener('change', async () => {
  try { await post('/api/generic', { enabled: genericToggle.checked }); }
  catch (error) { genericToggle.checked = !genericToggle.checked; }
});
attendanceToggle.addEventListener('change', async () => {
  try { await post('/api/attendance', { enabled: attendanceToggle.checked }); }
  catch (error) { $('#attendanceStatus').textContent = error.message; attendanceToggle.checked = !attendanceToggle.checked; }
});
enrollForm.addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#enrollName').value.trim();
  if (!name) return;
  try {
    await post('/api/attendance/enroll', { name });
    $('#attendanceStatus').textContent = 'Enrolling ' + name + '… hold still, facing the camera.';
    $('#enrollName').value = '';
  } catch (error) { $('#attendanceStatus').textContent = error.message; }
});
function renderAttendance(status) {
  const analysis = status.detection || {};
  if (document.activeElement !== attendanceToggle) {
    attendanceToggle.checked = analysis.attendanceOn ?? status.attendanceEnabled ?? false;
  }
  if (document.activeElement !== genericToggle) {
    genericToggle.checked = analysis.genericOn ?? status.genericEnabled ?? false;
  }
  const known = analysis.knownFaces || [];
  $('#enrolledList').textContent = known.length ? 'Enrolled: ' + known.join(', ') : 'No faces enrolled yet.';
  const recognized = (analysis.faces || []).map(f => f.name || 'Unknown');
  const enroll = analysis.enrollStatus;
  if (enroll && Date.now() - Date.parse(enroll.at) < 6000) $('#attendanceStatus').textContent = enroll.message;
  else if (analysis.attendanceOn) $('#attendanceStatus').textContent = recognized.length ? 'Recognizing: ' + recognized.join(', ') : 'Face recognition on — no face in view.';
  else if (status.state === 'connected') $('#attendanceStatus').textContent = 'Enable face recognition, or enrol a new face.';
}

function textElement(tag, content) {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}
const reviewName = value => ({ unreviewed: 'Unreviewed', confirmed: 'Confirmed', false_alert: 'False alert', unclear: 'Unclear' })[value] || value;
function renderAlerts() {
  const filter = $('#reviewFilter').value;
  const shown = alerts.filter(a => filter === 'all' || a.review === filter);
  $('#historyStatus').textContent = shown.length ? shown.length + ' saved review(s)' : 'No reviews to show. Automatic alerts and manually saved clips will appear here.';
  $('#reviewAlerts').replaceChildren(...shown.map(alert => {
    const card = document.createElement('article');
    card.className = 'review-card';
    card.append(textElement('h3', alert.headline),
      textElement('p', new Date(alert.at).toLocaleString() + ' · ' + (alert.source === 'manual' ? 'Manual save' : alert.object || 'Item')),
      textElement('p', reviewName(alert.review) + ' · Clip: ' + alert.mediaStatus + (alert.partial ? ' (shortened)' : '')));
    const button = textElement('button', 'Open review');
    button.className = 'secondary';
    button.addEventListener('click', () => openReview(alert.id));
    card.append(button);
    return card;
  }));
}
$('#reviewFilter').addEventListener('change', renderAlerts);

function updateMedia(alert) {
  const url = alert.media['clip.mp4'];
  if (url && video.getAttribute('src') !== url) video.src = url;
  video.hidden = !url;
  $('#downloadClip').hidden = !url;
  if (url) $('#downloadClip').href = url + '?download=1';
  $('#mediaStatus').textContent = alert.mediaStatus === 'failed' ? alert.mediaError
    : ['capturing', 'encoding'].includes(alert.mediaStatus) ? 'Preparing video… snapshots are available below.'
    : alert.partial ? 'Capture was interrupted. Available footage has been preserved.'
    : alert.mediaStatus === 'legacy' ? 'Imported clip. If it does not play, download it to view in VLC.' : '';
  for (const [name, image, figure] of [
    ['snapshot_pickup.jpg', '#pickupSnapshot', '#pickupFigure'],
    ['snapshot_disappear.jpg', '#disappearSnapshot', '#disappearFigure'],
  ]) {
    $(figure).hidden = !alert.media[name];
    if (alert.media[name]) $(image).src = alert.media[name];
    else $(image).removeAttribute('src');
  }
}
function openReview(id) {
  const alert = alerts.find(a => a.id === id);
  if (!alert) return;
  selectedId = id;
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#reviewTitle').textContent = alert.headline;
  $('#reviewReason').textContent = alert.reason + (alert.temporaryPersonId ? ' Person: ' + alert.temporaryPersonId + '.' : '');
  $('#reviewDecision').value = alert.review || 'unreviewed';
  $('#reviewNotes').value = alert.notes || '';
  $('#reviewFeedback').textContent = '';
  updateMedia(alert);
  if (!dialog.open) dialog.showModal();
}
$('#closeReview').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { video.pause(); video.removeAttribute('src'); video.load(); selectedId = null; });
video.addEventListener('error', () => { $('#mediaStatus').textContent = 'This video could not play. Download the clip to inspect it in a video player.'; });
$('#reviewForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedId) return;
  $('#saveReview').disabled = true;
  try {
    await post('/api/alerts/' + selectedId + '/review', { review: $('#reviewDecision').value, notes: $('#reviewNotes').value });
    $('#reviewFeedback').textContent = 'Review saved.';
    await refreshAlerts();
  } catch (error) { $('#reviewFeedback').textContent = error.message; }
  finally { $('#saveReview').disabled = false; }
});
$('#saveClip').addEventListener('click', async () => {
  $('#saveClip').disabled = true;
  try {
    const saved = await post('/api/alerts/manual');
    await refreshAlerts();
    openReview(saved.id);
  } catch (error) { $('#diagnosticMessage').textContent = error.message; }
});
async function refreshAlerts() {
  const result = await fetchJson('/api/alerts');
  alerts = result.alerts;
  const unreviewed = alerts.filter(a => a.review === 'unreviewed').length;
  $('#alertNotice').textContent = unreviewed ? unreviewed + ' event(s) awaiting review' : 'Review history';
  const signature = JSON.stringify(alerts);
  if (signature !== alertSignature) { alertSignature = signature; renderAlerts(); }
  if (result.warning) $('#historyStatus').textContent = result.warning;
  if (selectedId) {
    const alert = alerts.find(a => a.id === selectedId);
    if (alert) updateMedia(alert); // Never overwrite unsaved notes or restart playback.
  }
}
async function poll() {
  try { renderStatus(await fetchJson('/api/status')); }
  catch { renderStatus({ state: 'error', message: 'Local camera service unavailable. Start it with npm start.' }); }
  try { await refreshAlerts(); }
  catch { $('#historyStatus').textContent = 'Review history is temporarily unavailable.'; }
  setTimeout(poll, 1000);
}
fetchJson('/api/config').then(config => { if (!sourceDirty) input.value = config.rtspUrl; })
  .catch(() => { if (!sourceDirty) input.value = 'rtsp://192.168.1.2:8554'; });
poll();
