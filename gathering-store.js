const {randomUUID}=require('node:crypto');
const {localDate}=require('./attendance');
const {validDate}=require('./station-store');
function colorHue(color){const c=color.slice(1).match(/../g).map(x=>parseInt(x,16)/255),max=Math.max(...c),min=Math.min(...c),d=max-min;return {h:d?((max===c[0]?(c[1]-c[2])/d:max===c[1]?(c[2]-c[0])/d+2:(c[0]-c[1])/d+4)*60+360)%360:0,s:max?d/max:0,v:max};}
class GatheringStore{
  constructor(work){this.work=work;this.db=work.db;this.now=work.now;this.live=new Map();this.last=null;this.counts=[];
    this.db.exec(`CREATE TABLE IF NOT EXISTS gathering_roles(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gathering_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,zone_id TEXT NOT NULL REFERENCES work_zones(id),requirements TEXT NOT NULL,seconds REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS gathering_events(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,name TEXT NOT NULL,zone TEXT NOT NULL,started_at TEXT NOT NULL,confirmed_at TEXT NOT NULL,last_seen TEXT NOT NULL,ended_at TEXT,duration_seconds REAL NOT NULL,roles TEXT NOT NULL,people TEXT NOT NULL,review TEXT NOT NULL DEFAULT 'unreviewed',notes TEXT NOT NULL DEFAULT '');`);
    this.db.prepare('UPDATE gathering_events SET ended_at=last_seen WHERE ended_at IS NULL').run();
    if(!this.db.prepare('PRAGMA table_info(gathering_events)').all().some(c=>c.name==='input_mode'))this.db.exec("ALTER TABLE gathering_events ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'people'");
  }
  mode(){return this.work.station.setting('work_input_mode','people');}
  setMode(mode){if(!['people','tabletop'].includes(mode))throw Error('Choose People or Tabletop test mode');this.work.station.setSetting('work_input_mode',mode);this.work.changed();return {inputMode:mode};}
  roles(){return this.db.prepare('SELECT * FROM gathering_roles ORDER BY name').all();}
  rules(){return this.db.prepare('SELECT * FROM gathering_rules ORDER BY name').all().map(r=>({...r,requirements:JSON.parse(r.requirements),enabled:!!r.enabled}));}
  saveRole(input,id=null){
    const name=String(input.name||'').trim(),color=String(input.color||'').toLowerCase();
    if(!name||name.length>60)throw Error('Name the role (up to 60 characters)');
    if(!/^#[0-9a-f]{6}$/.test(color))throw Error('Choose a role color');
    const neutral=['#000000','#ffffff'].includes(color),selected=colorHue(color);
    if(neutral&&this.mode()!=='tabletop')throw Error('Black and white markers require Tabletop test mode');
    if(!neutral&&(selected.s<.55||selected.v<.45))throw Error('Choose a saturated color, or Black / White in Tabletop test mode');
    if(id&&!this.roles().some(r=>r.id===id))throw Error('Unknown role');
    for(const r of this.roles().filter(r=>r.id!==id)){if(neutral||['#000000','#ffffff'].includes(r.color)){if(r.color===color)throw Error('Role colors must be distinct');continue;}const d=Math.abs(selected.h-colorHue(r.color).h);if(Math.min(d,360-d)<24)throw Error('Role colors must be distinct');}
    // Role markers and personal markers must not describe the same pixels.
    if(!neutral)for(const a of this.work.assignments()){const d=Math.abs(selected.h-colorHue(a.color).h);if(Math.min(d,360-d)<24)throw Error('Choose a role color distinct from individual staff markers');}
    id=id||randomUUID();this.db.prepare('INSERT INTO gathering_roles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color').run(id,name,color);this.work.changed();return {id,name,color};
  }
  removeRole(id){if(this.rules().some(r=>r.requirements.some(q=>q.roleId===id)))throw Error('Remove this role from gathering rules first');this.db.prepare('DELETE FROM gathering_roles WHERE id=?').run(id);this.work.changed();}
  saveRule(input,id=null){
    const name=String(input.name||'').trim(),roles=this.roles(),requirements=input.requirements;
    if(!name||name.length>80)throw Error('Name the rule (up to 80 characters)');
    if(!this.work.zones().some(z=>z.id===input.zoneId))throw Error('Choose a saved region');
    if(!Array.isArray(requirements)||!requirements.length||requirements.length>roles.length||new Set(requirements.map(q=>q.roleId)).size!==requirements.length||requirements.some(q=>!roles.some(r=>r.id===q.roleId)||!Number.isInteger(q.count)||q.count<1||q.count>50)||requirements.reduce((n,q)=>n+q.count,0)<2)throw Error('Require at least two people with valid role counts');
    if(!Number.isFinite(input.seconds)||input.seconds<1||input.seconds>3600)throw Error('Duration must be 1–3600 seconds');
    if(typeof input.enabled!=='boolean')throw Error('Choose whether the rule is enabled');
    if(id&&!this.rules().some(r=>r.id===id))throw Error('Unknown gathering rule');
    id=id||randomUUID();this.db.prepare('INSERT INTO gathering_rules VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,zone_id=excluded.zone_id,requirements=excluded.requirements,seconds=excluded.seconds,enabled=excluded.enabled').run(id,name,input.zoneId,JSON.stringify(requirements),input.seconds,+input.enabled);this.work.changed();return this.rules().find(r=>r.id===id);
  }
  removeRule(id){this.db.prepare('DELETE FROM gathering_rules WHERE id=?').run(id);this.work.changed();}
  finish(entry){if(entry?.eventId)this.db.prepare('UPDATE gathering_events SET ended_at=last_seen WHERE id=?').run(entry.eventId);}
  pause(){for(const entry of this.live.values())this.finish(entry);this.live.clear();this.last=null;this.counts=[];}
  observe(observations,at,revision,inputMode='people'){
    if(inputMode!==this.mode()){this.pause();return;}
    if(revision!==this.work.revision()||!Array.isArray(observations)||!Number.isFinite(at)||at>this.now()+1000||this.now()-at>5000){this.pause();return;}
    if(this.last!==null&&at<=this.last)return;
    if(this.last!==null&&at-this.last>3000)this.pause();
    this.last=at;const roles=this.roles(),zones=this.work.zones();
    const unique=new Map();for(const o of observations)if(Number.isInteger(o.trackId)&&roles.some(r=>r.id===o.roleId)){
      if(unique.has(o.trackId))unique.set(o.trackId,null);else unique.set(o.trackId,o);
    }
    const people=[...unique.values()].filter(o=>o?.state==='confirmed'&&Array.isArray(o.zoneIds));
    this.counts=zones.map(z=>({zoneId:z.id,name:z.name,roles:roles.map(r=>({roleId:r.id,name:r.name,color:r.color,count:people.filter(o=>o.roleId===r.id&&o.zoneIds.includes(z.id)).length}))}));
    for(const rule of this.rules()){
      const matching=people.filter(o=>o.zoneIds.includes(rule.zone_id)&&rule.requirements.some(q=>q.roleId===o.roleId));
      const qualifies=rule.enabled&&rule.requirements.every(q=>matching.filter(o=>o.roleId===q.roleId).length>=q.count);
      let entry=this.live.get(rule.id);
      if(!qualifies){this.finish(entry);this.live.delete(rule.id);continue;}
      // Keep a stable minimum cohort. Extra arrivals do not interrupt it; departures reset.
      const retained=entry&&entry.people.every(p=>matching.some(o=>o.trackId===p.trackId&&o.roleId===p.roleId));
      if(!retained){this.finish(entry);entry={since:at,last:at,eventId:null,people:rule.requirements.flatMap(q=>matching.filter(o=>o.roleId===q.roleId).sort((a,b)=>a.trackId-b.trackId).slice(0,q.count).map(o=>({trackId:o.trackId,roleId:o.roleId}))) };this.live.set(rule.id,entry);}
      entry.last=at;const seconds=(at-entry.since)/1000;
      if(!entry.eventId&&seconds>=rule.seconds){entry.eventId=randomUUID();this.db.prepare('INSERT INTO gathering_events(id,rule_id,name,zone,started_at,confirmed_at,last_seen,duration_seconds,roles,people,input_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(entry.eventId,rule.id,rule.name,zones.find(z=>z.id===rule.zone_id).name,new Date(entry.since).toISOString(),new Date(at).toISOString(),new Date(at).toISOString(),seconds,JSON.stringify(rule.requirements.map(q=>({...q,name:roles.find(r=>r.id===q.roleId).name}))),JSON.stringify(entry.people),inputMode);}
      else if(entry.eventId)this.db.prepare('UPDATE gathering_events SET last_seen=?,duration_seconds=? WHERE id=?').run(new Date(at).toISOString(),seconds,entry.eventId);
    }
  }
  report(date=localDate(new Date(this.now()))){validDate(date);const fresh=this.last!==null&&this.now()-this.last<=5000;
    const events=this.db.prepare('SELECT * FROM gathering_events ORDER BY confirmed_at DESC').all().filter(e=>localDate(new Date(e.started_at))===date||localDate(new Date(e.last_seen))===date).map(e=>({...e,roles:JSON.parse(e.roles),people:JSON.parse(e.people),active:fresh&&[...this.live.values()].some(l=>l.eventId===e.id)}));
    return {inputMode:this.mode(),counts:fresh?this.counts:[],rules:this.rules().map(r=>{const live=fresh?this.live.get(r.id):null;return {...r,elapsedSeconds:live?(live.last-live.since)/1000:0,state:!r.enabled?'disabled':!fresh?'not_observed':live?.eventId?'flagged':live?'timing':'clear'};}),events};
  }
  review(id,input){if(!['unreviewed','reviewed','allowed_task','false_match'].includes(input.review)||typeof input.notes!=='string'||input.notes.length>2000)throw Error('Choose a review status and notes up to 2000 characters');if(!this.db.prepare('SELECT id FROM gathering_events WHERE id=?').get(id))throw Error('Unknown gathering event');this.db.prepare('UPDATE gathering_events SET review=?,notes=? WHERE id=?').run(input.review,input.notes,id);return {ok:true};}
}
module.exports={GatheringStore,colorHue};
