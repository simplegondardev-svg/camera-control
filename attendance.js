const fs = require('node:fs');
const path = require('node:path');

const STABLE_FRAMES = 3;
const STABLE_DURATION_MS = 1000;
const STABLE_GAP_MS = 2500;
const REARM_ABSENCE_MS = 30_000;
const DEFAULT_ATTENDANCE_START_TIME = '06:00';
const DEFAULT_ATTENDANCE_END_TIME = '22:00';

function isValidAttendanceTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}

function normalizeAttendanceSchedule(start, end) {
  const attendanceStartTime = isValidAttendanceTime(start)
    ? start
    : DEFAULT_ATTENDANCE_START_TIME;
  const attendanceEndTime = isValidAttendanceTime(end)
    ? end
    : DEFAULT_ATTENDANCE_END_TIME;
  if (attendanceStartTime >= attendanceEndTime) {
    return {
      attendanceStartTime: DEFAULT_ATTENDANCE_START_TIME,
      attendanceEndTime: DEFAULT_ATTENDANCE_END_TIME,
    };
  }
  return { attendanceStartTime, attendanceEndTime };
}

function isAttendanceWindowActive(now, start, end) {
  const schedule = normalizeAttendanceSchedule(start, end);
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return currentTime >= schedule.attendanceStartTime &&
    currentTime < schedule.attendanceEndTime;
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

class AttendanceStore {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.records = this.load();
    this.states = new Map();
    this.currentDate = null;
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    const records = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(records) || records.some(record =>
      typeof record.person !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
      typeof record.arrival !== 'string' ||
      !(record.departure === null || typeof record.departure === 'string')
    )) {
      throw Error(`Invalid attendance records in ${this.file}`);
    }
    return records;
  }

  list() {
    return this.records
      .map(record => ({ ...record }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.person.localeCompare(b.person));
  }

  persist(records) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify(records, null, 2));
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
      throw error;
    }
  }

  stateFor(person, date) {
    let state = this.states.get(person);
    if (!state) {
      const record = this.records.find(item => item.person === person && item.date === date);
      state = {
        latched: Boolean(record && record.departure === null),
        lastSeenAt: null,
        missingSince: null,
        candidateSince: null,
        candidateLastSeen: null,
        candidateFrames: 0,
      };
      this.states.set(person, state);
    }
    return state;
  }

  recordRecognition(person, date, timestamp) {
    const next = this.records.map(record => ({ ...record }));
    const record = next.find(item => item.person === person && item.date === date);
    if (!record) {
      next.push({ person, date, arrival: timestamp, departure: null });
    } else if (record.departure === null) {
      record.departure = timestamp;
    } else {
      return;
    }
    this.persist(next);
    this.records = next;
  }

  observe(faces, {
    livenessEnabled = true,
    attendanceStartTime = DEFAULT_ATTENDANCE_START_TIME,
    attendanceEndTime = DEFAULT_ATTENDANCE_END_TIME,
  } = {}) {
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw Error('Attendance clock returned an invalid date');
    }
    const date = localDate(now);
    const time = now.getTime();
    if (date !== this.currentDate) {
      this.states.clear();
      this.currentDate = date;
      for (const record of this.records) {
        if (record.date === date && record.departure === null) {
          this.stateFor(record.person, date);
        }
      }
    }

    if (!isAttendanceWindowActive(now, attendanceStartTime, attendanceEndTime)) {
      for (const state of this.states.values()) {
        state.candidateSince = null;
        state.candidateLastSeen = null;
        state.candidateFrames = 0;
      }
      return;
    }

    const recognized = new Set(
      (Array.isArray(faces) ? faces : [])
        .map(face => {
          const acceptedLiveness = livenessEnabled
            ? face?.liveness === 'LIVE'
            : face?.liveness === 'DISABLED';
          return acceptedLiveness && typeof face?.name === 'string' ? face.name.trim() : '';
        })
        .filter(Boolean),
    );

    for (const [person, state] of this.states) {
      if (!recognized.has(person)) {
        state.candidateSince = null;
        state.candidateLastSeen = null;
        state.candidateFrames = 0;
        if (state.latched) {
          if (state.missingSince === null) state.missingSince = state.lastSeenAt ?? time;
          if (time - state.missingSince >= REARM_ABSENCE_MS) state.latched = false;
        }
        continue;
      }

      if (state.latched && state.lastSeenAt !== null &&
          time - state.lastSeenAt >= REARM_ABSENCE_MS) {
        state.latched = false;
      }
      state.lastSeenAt = time;
      state.missingSince = null;
      if (state.latched) continue;

      if (state.candidateLastSeen === null || time - state.candidateLastSeen > STABLE_GAP_MS) {
        state.candidateSince = time;
        state.candidateFrames = 1;
      } else {
        state.candidateFrames += 1;
      }
      state.candidateLastSeen = time;

      if (state.candidateFrames >= STABLE_FRAMES &&
          time - state.candidateSince >= STABLE_DURATION_MS) {
        this.recordRecognition(person, date, now.toISOString());
        state.latched = true;
        state.candidateSince = null;
        state.candidateLastSeen = null;
        state.candidateFrames = 0;
      }
    }

    for (const person of recognized) {
      if (!this.states.has(person)) {
        const state = this.stateFor(person, date);
        if (state.latched) {
          state.lastSeenAt = time;
          state.missingSince = null;
          continue;
        }
        state.lastSeenAt = time;
        state.candidateSince = time;
        state.candidateLastSeen = time;
        state.candidateFrames = 1;
      }
    }
  }
}

module.exports = {
  AttendanceStore,
  DEFAULT_ATTENDANCE_END_TIME,
  DEFAULT_ATTENDANCE_START_TIME,
  isAttendanceWindowActive,
  isValidAttendanceTime,
  localDate,
  normalizeAttendanceSchedule,
};
