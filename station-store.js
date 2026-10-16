const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { localDate, isValidAttendanceTime } = require('./attendance');

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Choose a valid date');
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime()) || localDate(date) !== value) throw Error('Choose a valid date');
  return value;
}

function scheduleFor(staff, now) {
  const start = new Date(now);
  start.setHours(...staff.startTime.split(':').map(Number), 0, 0);
  const overnight = staff.endTime < staff.startTime;
  if (overnight && now.getHours() * 60 + now.getMinutes() < Number(staff.endTime.slice(0, 2)) * 60 + Number(staff.endTime.slice(3))) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setHours(...staff.endTime.split(':').map(Number), 0, 0);
  if (overnight) end.setDate(end.getDate() + 1);
  return { date: localDate(start), start, end, expected: staff.days.includes(start.getDay()) };
}

class StationStore {
  constructor(file, { now = () => new Date(), legacyDir = null } = {}) {
    this.now = now;
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, days TEXT NOT NULL,
        grace_minutes INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS face_embeddings (
        id INTEGER PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id), vector BLOB NOT NULL,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attendance_sessions (
        id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id), work_date TEXT NOT NULL,
        check_in TEXT NOT NULL, check_out TEXT, scheduled_start TEXT, scheduled_end TEXT,
        late_minutes INTEGER NOT NULL DEFAULT 0, early_minutes INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'station');
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_station_session ON attendance_sessions(staff_id)
        WHERE check_out IS NULL AND source='station';
      CREATE INDEX IF NOT EXISTS attendance_date ON attendance_sessions(work_date);
      CREATE TABLE IF NOT EXISTS scan_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES attendance_sessions(id),
        staff_id TEXT NOT NULL REFERENCES staff(id), action TEXT NOT NULL CHECK(action IN ('in','out')),
        at TEXT NOT NULL, score REAL, liveness TEXT NOT NULL);`);
    this.scan = { state: 'idle', message: 'Choose Check in or Check out, then face the camera.' };
    this.candidate = null;
    if (legacyDir) this.migrate(legacyDir);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  config() {
    return this.setting('attendance_config', { enabled: false, livenessEnabled: false, attendanceStartTime: '06:00', attendanceEndTime: '22:00' });
  }
  migrate(root) {
    if (this.setting('legacy_imported', false)) return;
    const read = (name, fallback) => {
      const file = path.join(root, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    };
    // All imports commit together; original files remain untouched.
    const faces = read('face-db.json', {});
    const records = read('attendance-records.json', []);
    const config = read('attendance-config.json', this.config());
    if (!Array.isArray(records) || !faces || typeof faces !== 'object' || Array.isArray(faces)) throw Error('Legacy attendance data is invalid; original files have been preserved');
    this.transaction(() => {
      this.setSetting('attendance_config', config);
      const names = new Map();
      const person = name => {
        if (typeof name !== 'string' || !name.trim()) throw Error('Legacy staff name is invalid');
        if (!names.has(name)) {
          const id = randomUUID();
          const staff = this.saveStaff({ name, code: `IMPORT-${id.slice(0, 8)}`, startTime: '09:00', endTime: '17:00', days: [1,2,3,4,5], graceMinutes: 5 });
          names.set(name, staff.id);
        }
        return names.get(name);
      };
      for (const [name, vectors] of Object.entries(faces)) {
        const id = person(name);
        if (!Array.isArray(vectors)) throw Error('Legacy face samples are invalid');
        for (const vector of vectors.slice(-5)) {
          const flat = vector.flat(Infinity);
          if (flat.length !== 128 || flat.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw Error('Legacy face sample is invalid');
          this.db.prepare('INSERT INTO face_embeddings(staff_id,vector,created_at) VALUES (?,?,?)').run(id, Buffer.from(new Float32Array(flat).buffer), this.now().toISOString());
        }
      }
      for (const record of records) {
        if (Number.isNaN(Date.parse(record.arrival)) || (record.departure !== null && Number.isNaN(Date.parse(record.departure)))) throw Error('Legacy attendance timestamp is invalid');
        this.db.prepare("INSERT INTO attendance_sessions(id,staff_id,work_date,check_in,check_out,source) VALUES (?,?,?,?,?,'legacy')").run(randomUUID(), person(record.person), validDate(record.date), record.arrival, record.departure);
      }
      this.setSetting('legacy_imported', true);
    });
  }
  mapStaff(row) {
    if (!row) return null;
    return { id: row.id, code: row.code, name: row.name, department: row.department, active: Boolean(row.active), startTime: row.start_time, endTime: row.end_time, days: JSON.parse(row.days), graceMinutes: row.grace_minutes, faceSamples: row.face_samples ?? 0 };
  }
  staff() {
    return this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM face_embeddings f WHERE f.staff_id=s.id) AS face_samples FROM staff s ORDER BY s.active DESC, s.name COLLATE NOCASE`).all().map(row => this.mapStaff(row));
  }
  getStaff(id) { return this.staff().find(staff => staff.id === id) || null; }
  saveStaff(input, id = null) {
    const name = String(input.name ?? '').trim();
    const code = String(input.code ?? '').trim();
    const department = String(input.department ?? '').trim();
    if (!name || name.length > 80 || !code || code.length > 40 || department.length > 80) throw Error('Enter a name and unique staff ID (up to 80 and 40 characters)');
    if (!isValidAttendanceTime(input.startTime) || !isValidAttendanceTime(input.endTime) || input.startTime === input.endTime) throw Error('Set different shift start and end times; one-minute and overnight shifts are supported');
    if (!Array.isArray(input.days) || !input.days.length || input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw Error('Choose at least one working day');
    if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 0 || input.graceMinutes > 120) throw Error('Grace period must be 0–120 minutes');
    if (id && !this.getStaff(id)) throw Error('Unknown staff member');
    const duplicate = this.db.prepare('SELECT id FROM staff WHERE code=? COLLATE NOCASE').get(code);
    if (duplicate && duplicate.id !== id) throw Error('That staff ID is already in use');
    const staffId = id || randomUUID();
    this.db.prepare(`INSERT INTO staff(id,code,name,department,active,start_time,end_time,days,grace_minutes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,
      department=excluded.department,active=excluded.active,start_time=excluded.start_time,
      end_time=excluded.end_time,days=excluded.days,grace_minutes=excluded.grace_minutes`).run(staffId, code, name, department, input.active === false ? 0 : 1, input.startTime, input.endTime, JSON.stringify([...new Set(input.days)].sort()), input.graceMinutes, this.now().toISOString());
    return this.getStaff(staffId);
  }
  arm(action) {
    if (!['in', 'out'].includes(action)) throw Error('Choose Check in or Check out');
    this.candidate = null;
    this.scan = { state: 'scanning', action, armedAt: this.now().getTime(), expiresAt: this.now().getTime() + 20000, message: `Look at the camera to check ${action}.` };
    return this.scanStatus();
  }
  cancel(message = 'Scan cancelled. Choose Check in or Check out when ready.') {
    this.candidate = null;
    this.scan = { state: 'idle', message };
  }
  scanStatus() {
    if (this.scan.state === 'scanning' && this.now().getTime() >= this.scan.expiresAt) this.cancel('Scan timed out. Choose an action and try again.');
    return { ...this.scan };
  }
  observe(faces, { livenessEnabled = false } = {}) {
    if (this.scanStatus().state !== 'scanning') return;
    if (!Array.isArray(faces) || faces.length !== 1) {
      this.candidate = null;
      this.scan.message = faces?.length > 1 ? 'One person at a time. Please leave only one face in view.' : 'Look straight at the camera.';
      return;
    }
    const face = faces[0];
    const accepted = livenessEnabled ? face.liveness === 'LIVE' : face.liveness === 'DISABLED';
    if (!accepted || !face.staffId || !Number.isFinite(face.score) || face.score < 0.363) {
      this.candidate = null;
      this.scan.message = !accepted ? 'Waiting for a stable live face.' : 'Face not recognized. Ask the administrator to enroll your face.';
      return;
    }
    const now = this.now().getTime();
    if (!this.candidate || this.candidate.id !== face.staffId || now - this.candidate.last > 2500) this.candidate = { id: face.staffId, since: now, last: now, frames: 0 };
    this.candidate.last = now;
    this.candidate.frames++;
    this.scan.message = `Confirming ${face.name}… hold still.`;
    if (this.candidate.frames < 3 || now - this.candidate.since < 1000) return;
    const action = this.scan.action;
    try {
      const result = this.recordScan(face.staffId, action, face);
      this.scan = { state: 'success', action, ...result, message: `${result.name} — checked ${action} successfully.` };
    } catch (error) {
      this.scan = { state: 'error', action, message: error.message, at: this.now().toISOString() };
    }
    this.candidate = null;
  }
  recordScan(id, action, face) {
    if (!['in', 'out'].includes(action)) throw Error('Invalid scan action');
    const staff = this.getStaff(id);
    if (!staff || !staff.active || !staff.faceSamples) throw Error('This staff member is inactive or has no enrolled face');
    const now = this.now();
    const at = now.toISOString();
    return this.transaction(() => {
      const open = this.db.prepare("SELECT * FROM attendance_sessions WHERE staff_id=? AND check_out IS NULL AND source='station'").get(id);
      let session;
      if (action === 'in') {
        if (open) throw Error(`${staff.name} is already checked in. Choose Check out when leaving.`);
        const last = this.db.prepare('SELECT at FROM scan_events WHERE staff_id=? ORDER BY at DESC LIMIT 1').get(id);
        if (last && now.getTime() - Date.parse(last.at) < 3000) throw Error('Scan already recorded. Wait three seconds before another scan.');
        const schedule = scheduleFor(staff, now);
        const late = schedule.expected ? Math.max(0, Math.ceil((now - schedule.start - staff.graceMinutes * 60000) / 60000)) : 0;
        const sessionId = randomUUID();
        this.db.prepare('INSERT INTO attendance_sessions(id,staff_id,work_date,check_in,scheduled_start,scheduled_end,late_minutes) VALUES (?,?,?,?,?,?,?)').run(sessionId, id, schedule.date, at, schedule.expected ? schedule.start.toISOString() : null, schedule.expected ? schedule.end.toISOString() : null, late);
        session = this.db.prepare('SELECT * FROM attendance_sessions WHERE id=?').get(sessionId);
      } else {
        if (!open) throw Error(`${staff.name} has no open check-in. Choose Check in first.`);
        if (now.getTime() - Date.parse(open.check_in) < 3000) throw Error('Wait three seconds after check-in before checking out. One-minute test shifts are supported.');
        const early = open.scheduled_end ? Math.max(0, Math.ceil((Date.parse(open.scheduled_end) - now.getTime()) / 60000)) : 0;
        this.db.prepare('UPDATE attendance_sessions SET check_out=?,early_minutes=? WHERE id=?').run(at, early, open.id);
        session = { ...open, check_out: at, early_minutes: early };
      }
      this.db.prepare('INSERT INTO scan_events VALUES (?,?,?,?,?,?,?)').run(randomUUID(), session.id, id, action, at, face.score, face.liveness);
      return { staffId: id, name: staff.name, code: staff.code, at, sessionId: session.id, lateMinutes: session.late_minutes, earlyMinutes: session.early_minutes, scheduledStart: session.scheduled_start, scheduledEnd: session.scheduled_end };
    });
  }
  daily(date = localDate(this.now())) {
    validDate(date);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const sessions = this.db.prepare('SELECT * FROM attendance_sessions WHERE work_date=? ORDER BY check_in').all(date);
    return this.staff().filter(staff => staff.active || sessions.some(session => session.staff_id === staff.id)).map(staff => {
      const allOwn = sessions.filter(session => session.staff_id === staff.id);
      const stationSessions = allOwn.filter(session => session.source === 'station');
      // Old inferred departures must not keep a new explicit station session open.
      const own = stationSessions.length ? stationSessions : allOwn;
      const expected = staff.active && staff.days.includes(weekday);
      const first = own[0];
      const last = own.at(-1);
      const open = own.some(session => !session.check_out);
      const late = own.reduce((sum, session) => sum + session.late_minutes, 0);
      const hhmm = value => { const time = new Date(value); return `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`; };
      const unscheduled = first && !first.scheduled_start && first.source !== 'legacy';
      return { staffId: staff.id, code: staff.code, name: staff.name, department: staff.department,
        schedule: first?.scheduled_start ? `${hhmm(first.scheduled_start)}–${hhmm(first.scheduled_end)}` : `${staff.startTime}–${staff.endTime}`, expected, arrival: first?.check_in ?? null,
        departure: !open ? last?.check_out ?? null : null, lateMinutes: late,
        earlyMinutes: own.reduce((sum, session) => sum + session.early_minutes, 0),
        workedMinutes: Math.floor(own.reduce((sum, session) => sum + (session.check_out ? Math.max(0, Date.parse(session.check_out) - Date.parse(session.check_in)) : 0), 0) / 60000),
        sessions: own.length, source: own.some(session => session.source === 'legacy') ? 'legacy' : 'station',
        status: !first ? expected ? 'Not scanned' : 'Off day' : first.source === 'legacy' ? open ? 'Legacy · needs review' : 'Legacy record' : open ? date < localDate(this.now()) ? 'Missing checkout' : unscheduled ? 'Unscheduled · checked in' : late ? 'Late · checked in' : 'Checked in' : unscheduled ? 'Unscheduled · checked out' : 'Checked out' };
    });
  }
  events(date = localDate(this.now())) {
    validDate(date);
    return this.db.prepare(`SELECT e.id,e.action,e.at,s.name,s.code FROM scan_events e
      JOIN attendance_sessions a ON a.id=e.session_id JOIN staff s ON s.id=e.staff_id
      WHERE a.work_date=? ORDER BY e.at DESC LIMIT 100`).all(date);
  }
  eventCount(date = localDate(this.now())) {
    validDate(date);
    return this.db.prepare('SELECT COUNT(*) AS count FROM scan_events e JOIN attendance_sessions a ON a.id=e.session_id WHERE a.work_date=?').get(date).count;
  }
  list() { return this.db.prepare('SELECT s.name AS person,a.work_date AS date,a.check_in AS arrival,a.check_out AS departure FROM attendance_sessions a JOIN staff s ON s.id=a.staff_id ORDER BY a.check_in DESC').all(); }
  close() { this.db.close(); }
}
module.exports = { StationStore, scheduleFor, validDate };
