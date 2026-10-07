const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AttendanceStore,
  DEFAULT_ATTENDANCE_END_TIME,
  DEFAULT_ATTENDANCE_START_TIME,
  isAttendanceWindowActive,
  normalizeAttendanceSchedule,
} = require('./attendance');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-attendance-test-'));
const timestamp = (day, ms = 0) => new Date(2025, 9, day, 9, 0, 0, ms);
const atTime = (day, hour, minute, second = 0, ms = 0) =>
  new Date(2025, 9, day, hour, minute, second, ms);
const face = name => ({ name, score: name ? 0.9 : 0, liveness: 'LIVE' });
let current, day;
let store;

function setup() {
  day = 5;
  current = timestamp(day);
  const file = path.join(folder, 'attendance-records.json');
  fs.rmSync(file, { force: true });
  store = new AttendanceStore(file, { now: () => current });
}

function observeAt(ms, faces = [face('Alice')], options) {
  current = new Date(timestamp(day).getTime() + ms);
  store.observe(faces, options);
}

function observeAtDate(date, faces = [face('Alice')], options) {
  current = new Date(date);
  store.observe(faces, options);
}

function stableRecognition(startMs, name = 'Alice') {
  for (const offset of [0, 500, 1000]) observeAt(startMs + offset, [face(name)]);
}

function stableRecognitionAt(date, name = 'Alice', options) {
  for (const offset of [0, 500, 1000]) {
    observeAtDate(new Date(date.getTime() + offset), [face(name)], options);
  }
}

try {
  setup();
  stableRecognition(0);
  let records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].person, 'Alice');
  assert.equal(records[0].date, '2025-10-05');
  assert.equal(records[0].arrival, current.toISOString());
  assert.equal(records[0].departure, null);
  console.log('PASS: stable first recognition creates one arrival.');

  observeAt(31_000, []);
  stableRecognition(32_000);
  records = store.list();
  assert.equal(records.length, 1);
  assert.notEqual(records[0].departure, null);
  const departure = records[0].departure;
  console.log('PASS: later stable recognition after the absence cooldown records departure.');

  observeAt(63_000, []);
  stableRecognition(64_000);
  records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].departure, departure);
  console.log('PASS: third qualifying recognition does not change the completed record.');

  setup();
  for (let ms = 0; ms <= 120_000; ms += 500) observeAt(ms);
  records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].departure, null);
  console.log('PASS: continuous recognized frames do not become departure.');

  day = 6;
  current = timestamp(day);
  stableRecognition(0);
  records = store.list();
  assert.equal(records.length, 2);
  assert.equal(records[0].date, '2025-10-06');
  assert.equal(records[0].departure, null);
  console.log('PASS: first recognition on a new local day creates a new arrival.');

  setup();
  for (const ms of [0, 500, 1000]) observeAt(ms, [face(null)]);
  assert.deepEqual(store.list(), []);
  console.log('PASS: unknown faces create no attendance records.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [face('Alice'), face(null)]);
  }
  records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].person, 'Alice');
  assert.equal(records[0].departure, null);
  console.log('PASS: known person receives attendance beside an unknown person; unknown remains excluded.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [{ name: 'Alice', score: 0.99, liveness: 'SPOOF / REJECTED' }]);
  }
  assert.deepEqual(store.list(), []);
  for (const ms of [2000, 2500, 3000]) {
    observeAt(ms, [{ name: 'Alice', score: 0.99, liveness: 'INCONCLUSIVE' }]);
  }
  assert.deepEqual(store.list(), []);
  console.log('PASS: spoof and inconclusive liveness results cannot create attendance.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [{ name: 'Alice', score: 0.9, liveness: 'LIVE' }], { livenessEnabled: false });
  }
  assert.deepEqual(store.list(), []);
  console.log('PASS: LIVE-labelled results are not accepted when liveness is configured off.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [{ name: 'Alice', score: 0.9, liveness: 'DISABLED' }], { livenessEnabled: true });
  }
  assert.deepEqual(store.list(), []);
  console.log('PASS: DISABLED-labelled results are not accepted when liveness is configured on.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [{ name: 'Alice', score: 0.9, liveness: 'DISABLED' }], { livenessEnabled: false });
  }
  records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].person, 'Alice');
  assert.equal(records[0].departure, null);
  console.log('PASS: an explicitly DISABLED named result can create attendance only in liveness-off mode.');

  setup();
  for (const ms of [0, 500, 1000]) {
    observeAt(ms, [{ name: null, score: 0, liveness: 'DISABLED' }], { livenessEnabled: false });
  }
  assert.deepEqual(store.list(), []);
  console.log('PASS: unknown faces remain ineligible when liveness is off.');

  setup();
  for (const ms of [0, 500, 1000]) observeAt(ms, [{ name: 'Alice', score: 0.99 }]);
  assert.deepEqual(store.list(), []);
  console.log('PASS: missing liveness status is rejected by the attendance store.');

  setup();
  for (const ms of [0, 500, 1000]) observeAt(ms, [face('Alice'), face('Bob'), face('Alice')]);
  records = store.list();
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map(record => record.person)), new Set(['Alice', 'Bob']));
  console.log('PASS: multiple recognized people are tracked independently; duplicate detections count once per frame.');

  setup();
  stableRecognition(0);
  store = new AttendanceStore(path.join(folder, 'attendance-records.json'), { now: () => current });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].departure, null);
  console.log('PASS: attendance persists and reloads from local JSON.');

  const defaultSchedule = normalizeAttendanceSchedule(undefined, undefined);
  assert.deepEqual(defaultSchedule, {
    attendanceStartTime: DEFAULT_ATTENDANCE_START_TIME,
    attendanceEndTime: DEFAULT_ATTENDANCE_END_TIME,
  });
  assert.equal(isAttendanceWindowActive(atTime(5, 5, 59), '06:00', '22:00'), false);
  assert.equal(isAttendanceWindowActive(atTime(5, 6, 0), '06:00', '22:00'), true);
  assert.equal(isAttendanceWindowActive(atTime(5, 12, 0), '06:00', '22:00'), true);
  assert.equal(isAttendanceWindowActive(atTime(5, 21, 59), '06:00', '22:00'), true);
  assert.equal(isAttendanceWindowActive(atTime(5, 22, 0), '06:00', '22:00'), false);
  assert.equal(isAttendanceWindowActive(atTime(5, 23, 0), '06:00', '22:00'), false);
  assert.equal(isAttendanceWindowActive(atTime(5, 5, 59), 'invalid', '22:00'), false);
  assert.deepEqual(normalizeAttendanceSchedule('25:61', '22:00'), {
    attendanceStartTime: '06:00',
    attendanceEndTime: '22:00',
  });
  assert.deepEqual(normalizeAttendanceSchedule('22:00', '06:00'), {
    attendanceStartTime: '06:00',
    attendanceEndTime: '22:00',
  });
  console.log('PASS: schedule defaults and invalid values deterministically use 06:00–22:00.');

  setup();
  stableRecognitionAt(atTime(5, 5, 59));
  assert.deepEqual(store.list(), []);
  console.log('PASS: 05:59 does not create attendance.');

  for (const [hour, minute, label] of [
    [6, 0, '06:00'],
    [12, 0, '12:00'],
    [21, 59, '21:59'],
  ]) {
    setup();
    stableRecognitionAt(atTime(5, hour, minute));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].person, 'Alice');
    console.log(`PASS: ${label} is attendance-eligible.`);
  }

  for (const [hour, label] of [[22, '22:00'], [23, '23:00']]) {
    setup();
    stableRecognitionAt(atTime(5, hour, 0));
    assert.deepEqual(store.list(), []);
    console.log(`PASS: ${label} does not create attendance.`);
  }

  setup();
  stableRecognitionAt(atTime(5, 21, 0));
  observeAtDate(atTime(5, 21, 1), []);
  stableRecognitionAt(atTime(5, 22, 0));
  records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].departure, null);
  console.log('PASS: outside-window recognition does not update an existing attendance record.');

  setup();
  observeAtDate(atTime(5, 21, 59, 30));
  observeAtDate(atTime(5, 21, 59, 59));
  observeAtDate(atTime(5, 22, 0));
  observeAtDate(atTime(5, 22, 0, 500));
  observeAtDate(atTime(5, 22, 1));
  assert.deepEqual(store.list(), []);
  console.log('PASS: a partially qualified candidate is cleared at the 22:00 closing boundary.');

  setup();
  stableRecognitionAt(atTime(5, 9, 0));
  const previousDayRecord = store.list().find(record => record.date === '2025-10-05');
  const previousDaySnapshot = { ...previousDayRecord };
  stableRecognitionAt(atTime(6, 6, 0));
  records = store.list();
  assert.equal(records.length, 2);
  assert.deepEqual(records.find(record => record.date === '2025-10-05'), previousDaySnapshot);
  assert.equal(records.find(record => record.date === '2025-10-06').arrival,
    new Date(atTime(6, 6, 0).getTime() + 1000).toISOString());
  console.log('PASS: next day at 06:00 starts fresh while previous-day history remains unchanged.');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
