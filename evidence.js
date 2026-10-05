const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function atomicJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

class EvidenceStore {
  constructor(root, ffmpeg) {
    this.root = root;
    this.ffmpeg = ffmpeg;
    this.records = new Map();
    this.pending = new Map();
    this.buffer = [];
    this.queue = Promise.resolve();
    this.lastSample = 0;
    this.error = null;
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
      const folder = path.join(root, entry.name);
      try {
        let record;
        if (fs.existsSync(path.join(folder, 'event.json'))) {
          record = JSON.parse(fs.readFileSync(path.join(folder, 'event.json'), 'utf8'));
        } else {
          const old = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
          record = { id: entry.name, at: old.created, reason: old.reason, temporaryPersonId: old.temporary_person_id,
            headline: 'Imported review clip', review: 'unreviewed', notes: '', mediaStatus: 'legacy' };
        }
        record.id = entry.name;
        this.records.set(record.id, record);
        if (['capturing', 'encoding'].includes(record.mediaStatus)) {
          record.partial = true;
          this.enqueue(record.id);
        }
      } catch { this.error = 'Some saved records could not be read. Their files have been preserved.'; }
    }
    this.timer = setInterval(() => {
      for (const [id, deadline] of this.pending) if (Date.now() >= deadline) this.finish(id);
    }, 250);
    this.timer.unref();
  }
  folder(id) {
    if (!this.records.has(id) || !/^[\w-]+$/.test(id)) throw Error('Unknown alert');
    return path.join(this.root, id);
  }
  persist(id) { atomicJson(path.join(this.folder(id), 'event.json'), this.records.get(id)); }
  list() {
    return [...this.records.values()].map(record => {
      const folder = this.folder(record.id);
      return { ...record, media: Object.fromEntries(['clip.mp4', 'snapshot_pickup.jpg', 'snapshot_disappear.jpg']
        .filter(name => fs.existsSync(path.join(folder, name)))
        .map(name => [name, `/api/alerts/${record.id}/media/${name}`])) };
    }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  review(id, review, notes) {
    if (!['unreviewed', 'confirmed', 'false_alert', 'unclear'].includes(review)) throw Error('Invalid review status');
    if (typeof notes !== 'string' || notes.length > 4000) throw Error('Notes must be at most 4000 characters');
    const record = this.records.get(id);
    if (!record) throw Error('Unknown alert');
    const next = { ...record, review, notes, reviewedAt: new Date().toISOString() };
    atomicJson(path.join(this.folder(id), 'event.json'), next);
    this.records.set(id, next);
    return next;
  }
  addFrame(jpeg, at = Date.now()) {
    if (at-this.lastSample < 200) return;
    this.lastSample = at;
    this.buffer.push({ at, jpeg });
    let bytes = this.buffer.reduce((n, f) => n+f.jpeg.length, 0);
    while (this.buffer.length && (at-this.buffer[0].at > 5000 || bytes > 32*1024*1024)) bytes -= this.buffer.shift().jpeg.length;
    for (const id of this.pending.keys()) {
      try { this.append(id, { at, jpeg }); }
      catch { this.fail(id, 'Could not save evidence frames. Check available disk space.'); }
    }
  }
  append(id, frame) {
    const folder = this.folder(id);
    const journalFile = path.join(folder, 'frames.json');
    const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : [];
    if (journal.length && frame.at <= journal.at(-1).at) return;
    const name = `frame${String(journal.length).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(folder, name), frame.jpeg);
    journal.push({ at: frame.at, name });
    atomicJson(journalFile, journal);
  }
  begin(event, currentFrame) {
    const id = randomUUID();
    const record = { id, at: new Date().toISOString(), headline: event.headline,
      object: event.object || 'item', temporaryPersonId: event.temporaryPersonId || null,
      reason: event.reason, source: event.source || 'automatic', review: 'unreviewed', notes: '', mediaStatus: 'capturing' };
    this.records.set(id, record);
    try {
      fs.mkdirSync(this.folder(id));
      this.persist(id); // Alert exists on disk before video encoding begins.
      if (event.pickup) fs.writeFileSync(path.join(this.folder(id), 'snapshot_pickup.jpg'), Buffer.from(event.pickup, 'base64'));
      if (currentFrame) fs.writeFileSync(path.join(this.folder(id), 'snapshot_disappear.jpg'), currentFrame);
      for (const frame of this.buffer) this.append(id, frame);
      this.pending.set(id, Date.now()+2500);
    } catch { this.fail(id, 'Could not save evidence. Check available disk space.'); }
    return id;
  }
  fail(id, message) {
    this.pending.delete(id);
    const record = this.records.get(id);
    if (record) {
      record.mediaStatus = 'failed';
      record.mediaError = message;
      try { this.persist(id); } catch { this.error = message; }
    }
  }
  finish(id, partial = false) {
    this.pending.delete(id);
    if (partial) this.records.get(id).partial = true;
    this.enqueue(id);
  }
  enqueue(id) {
    this.records.get(id).mediaStatus = 'encoding';
    try { this.persist(id); } catch { this.fail(id, 'Cannot save clip metadata'); return; }
    this.queue = this.queue.then(() => this.encode(id)).catch(() => this.fail(id, 'Clip encoding failed; snapshots and source frames are preserved.'));
  }
  async encode(id) {
    const folder = this.folder(id);
    const frames = JSON.parse(fs.readFileSync(path.join(folder, 'frames.json'), 'utf8'));
    if (!frames.length) throw Error('No frames');
    const manifest = frames.map((f, i) => `file '${f.name}'\nduration ${Math.max(.04, Math.min(5, ((frames[i+1]?.at ?? f.at+200)-f.at)/1000))}`).join('\n') + `\nfile '${frames.at(-1).name}'\n`;
    fs.writeFileSync(path.join(folder, 'frames.txt'), manifest);
    await new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'frames.txt',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'encoding.mp4'], { cwd: folder, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(Error('Encoding timeout')); }, 60000);
      child.stderr.on('data', () => {});
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Encoding failed')); });
    });
    fs.renameSync(path.join(folder, 'encoding.mp4'), path.join(folder, 'clip.mp4'));
    Object.assign(this.records.get(id), { mediaStatus: 'ready', frames: frames.length,
      durationSeconds: (frames.at(-1).at-frames[0].at)/1000+.2 });
    this.persist(id);
    // Only remove our temporary frames after a successful, durable clip commit.
    for (const frame of frames) fs.unlinkSync(path.join(folder, frame.name));
    for (const name of ['frames.json', 'frames.txt']) fs.unlinkSync(path.join(folder, name));
  }
  finishPending() { for (const id of [...this.pending.keys()]) this.finish(id, true); }
  resetBuffer() { this.buffer = []; this.lastSample = 0; }
  async close() { clearInterval(this.timer); this.finishPending(); await this.queue; }
}

module.exports = { EvidenceStore };
