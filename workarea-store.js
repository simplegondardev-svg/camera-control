const {randomUUID}=require('node:crypto');
const {validDate}=require('./station-store');
const {localDate}=require('./attendance');
const {GatheringStore,colorHue}=require('./gathering-store');
const {PreviewGatherings}=require('./preview-gatherings');
const STATES=['inside','outside','uncertain','not_visible'];
function hue(hex){const [r,g,b]=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;return {h:d===0?0:((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+360)%360,s:max?d/max:0,v:max};}
function polygon(points){
  if(!Array.isArray(points)||points.length<3||points.length>20||points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)))throw Error('Draw a polygon with 3–20 points inside the camera image');
  const area=Math.abs(points.reduce((sum,p,i)=>{const next=points[(i+1)%points.length];return sum+p[0]*next[1]-next[0]*p[1];},0))/2;
  if(area<.0025)throw Error('Work region is too small');
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    if(j===i+1||(i===0&&j===points.length-1))continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0)throw Error('Region edges must not cross or touch');
  }
  return points;
}
class WorkAreaStore{
  constructor(station,{now=()=>Date.now()}={}){
    this.station=station;this.db=station.db;this.now=now;this.live=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_zones(id TEXT PRIMARY KEY,name TEXT NOT NULL,points TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_assignments(staff_id TEXT PRIMARY KEY REFERENCES staff(id),color TEXT NOT NULL,outside_seconds REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS work_staff_zones(staff_id TEXT REFERENCES staff(id),zone_id TEXT REFERENCES work_zones(id),PRIMARY KEY(staff_id,zone_id));
      CREATE TABLE IF NOT EXISTS work_intervals(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES attendance_sessions(id),staff_id TEXT NOT NULL REFERENCES staff(id),state TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,region TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS work_intervals_session ON work_intervals(session_id);
      CREATE TABLE IF NOT EXISTS work_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES attendance_sessions(id),staff_id TEXT NOT NULL REFERENCES staff(id),at TEXT NOT NULL,started_at TEXT NOT NULL,outside_seconds REAL NOT NULL,allowed_seconds REAL NOT NULL,regions TEXT NOT NULL,review TEXT NOT NULL DEFAULT 'unreviewed',notes TEXT NOT NULL DEFAULT '');`);
    this.gathering=new GatheringStore(this);
    this.preview=new PreviewGatherings(this);
  }
  revision(){return this.station.setting('work_revision',0);}
  changed(){this.station.setSetting('work_revision',this.revision()+1);this.pause();}
  zones(){return this.db.prepare('SELECT * FROM work_zones ORDER BY name').all().map(z=>({...z,points:JSON.parse(z.points)}));}
  saveZone(input,id=null){
    const name=String(input.name||'').trim();if(!name||name.length>60)throw Error('Name the region (up to 60 characters)');const points=polygon(input.points);
    if(id&&!this.db.prepare('SELECT id FROM work_zones WHERE id=?').get(id))throw Error('Unknown region');
    id=id||randomUUID();this.db.prepare('INSERT INTO work_zones VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,points=excluded.points').run(id,name,JSON.stringify(points));this.changed();return {id,name,points};
  }
  removeZone(id){if(this.preview.rules().some(r=>r.zone_id===id))throw Error("Remove the Pink & White timer rule for this area first");if(this.gathering.rules().some(r=>r.zone_id===id))throw Error('Remove gathering rules for this region first');if(this.db.prepare('SELECT staff_id FROM work_staff_zones WHERE zone_id=? LIMIT 1').get(id))throw Error('Remove this region from staff assignments first');this.db.prepare('DELETE FROM work_zones WHERE id=?').run(id);this.changed();}
  assignments(){return this.db.prepare('SELECT * FROM work_assignments').all().map(row=>({staffId:row.staff_id,color:row.color,outsideSeconds:row.outside_seconds,zoneIds:this.db.prepare('SELECT zone_id FROM work_staff_zones WHERE staff_id=?').all(row.staff_id).map(z=>z.zone_id)}));}
  assign(id,input){
    const person=this.station.getStaff(id);if(!person||!person.active)throw Error('Select an active staff member');
    const color=String(input.color||'').toLowerCase();if(!/^#[0-9a-f]{6}$/.test(color))throw Error('Choose a marker color');
    const selected=hue(color);if(selected.s<.55||selected.v<.45)throw Error('Use a bright saturated marker color, not gray, black or white');
    for(const role of this.gathering.roles().filter(r=>!["#000000","#ffffff"].includes(r.color))){const difference=Math.abs(selected.h-colorHue(role.color).h);if(Math.min(difference,360-difference)<24)throw Error('Choose an individual marker distinct from role colors');}
    for(const other of this.assignments().filter(a=>a.staffId!==id)){
      const difference=Math.abs(selected.h-hue(other.color).h);
      if(Math.min(difference,360-difference)<24)throw Error('That color is too similar to another staff marker. Choose a more distinct color.');
    }
    if(typeof input.outsideSeconds!=='number'||!Number.isFinite(input.outsideSeconds)||input.outsideSeconds<1||input.outsideSeconds>3600)throw Error('Outside allowance must be 1–3600 seconds');
    if(!Array.isArray(input.zoneIds)||!input.zoneIds.length||input.zoneIds.some(id=>!this.zones().some(z=>z.id===id)))throw Error('Assign at least one saved work region');
    this.station.transaction(()=>{
      this.db.prepare('INSERT INTO work_assignments VALUES (?,?,?) ON CONFLICT(staff_id) DO UPDATE SET color=excluded.color,outside_seconds=excluded.outside_seconds').run(id,color,input.outsideSeconds);
      this.db.prepare('DELETE FROM work_staff_zones WHERE staff_id=?').run(id);
      for(const zoneId of new Set(input.zoneIds))this.db.prepare('INSERT INTO work_staff_zones VALUES (?,?)').run(id,zoneId);
      this.changed();
    });return this.assignments().find(a=>a.staffId===id);
  }
  sessions(){return this.db.prepare("SELECT a.id,a.staff_id,a.check_in,s.name,s.code FROM attendance_sessions a JOIN staff s ON s.id=a.staff_id WHERE a.source='station' AND a.check_out IS NULL AND s.active=1").all();}
  config(){return {revision:this.revision(),zones:this.zones(),assignments:this.assignments(),staff:this.station.staff(),inputMode:this.gathering.mode(),gatheringRoles:this.gathering.roles(),gatheringRules:this.gathering.rules()};}
  workerConfig(){const assignments=this.assignments(),zones=this.zones();return {revision:this.revision(),zones,inputMode:this.gathering.mode(),roles:this.gathering.roles(),staff:(this.gathering.mode()==='people'?this.sessions():[]).flatMap(session=>{const assignment=assignments.find(a=>a.staffId===session.staff_id);return assignment?[{id:session.staff_id,sessionId:session.id,name:session.name,color:assignment.color,zoneIds:assignment.zoneIds}]:[];})};}
  pause(){this.live.clear();this.gathering.pause();this.preview?.pause();}
  interval(session,state,start,end,region){
    if(end<=start)return;
    const last=this.db.prepare('SELECT * FROM work_intervals WHERE session_id=? ORDER BY id DESC LIMIT 1').get(session.id);
    if(last&&last.state===state&&last.region===region&&last.end_ms===start)this.db.prepare('UPDATE work_intervals SET end_ms=? WHERE id=?').run(end,last.id);
    else this.db.prepare('INSERT INTO work_intervals(session_id,staff_id,state,start_ms,end_ms,region) VALUES (?,?,?,?,?,?)').run(session.id,session.staff_id,state,start,end,region);
  }
  observe(observations,at,revision){
    if(revision!==this.revision()||!Array.isArray(observations)||!Number.isFinite(at)||at>this.now()+1000||this.now()-at>5000){this.pause();return;}
    const assignments=this.assignments();
    this.station.transaction(()=>{
      const sessions=this.sessions(),active=new Set(sessions.map(s=>s.staff_id));
      for(const id of this.live.keys())if(!active.has(id))this.live.delete(id);
      for(const session of sessions){
        if(at<Date.parse(session.check_in))continue;
        const assignment=assignments.find(a=>a.staffId===session.staff_id);if(!assignment)continue;
        const matches=observations.filter(o=>o.staffId===session.staff_id&&o.sessionId===session.id);
        const sample=matches.length===1&&STATES.includes(matches[0].state)?matches[0]:{state:matches.length>1?'uncertain':'not_visible'};
        const region=typeof sample.region==='string'?sample.region.slice(0,200):'';
        const prior=this.live.get(session.staff_id);
        if(prior&&at<=prior.at)continue;
        const continuous=prior&&prior.sessionId===session.id&&at-prior.at<=3000;
        if(continuous)this.interval(session,prior.state===sample.state?sample.state:'uncertain',Math.max(prior.at,Date.parse(session.check_in)),at,prior.state===sample.state?region:'');
        const sameOutside=continuous&&prior.state==='outside'&&sample.state==='outside';
        const entry={sessionId:session.id,state:sample.state,region,at,outsideSince:sample.state==='outside'?(sameOutside?prior.outsideSince:at):null,alerted:sameOutside?prior.alerted:false};
        if(entry.outsideSince!==null&&!entry.alerted&&(at-entry.outsideSince)/1000>=assignment.outsideSeconds){
          this.db.prepare('INSERT INTO work_events(id,session_id,staff_id,at,started_at,outside_seconds,allowed_seconds,regions) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),session.id,session.staff_id,new Date(at).toISOString(),new Date(entry.outsideSince).toISOString(),(at-entry.outsideSince)/1000,assignment.outsideSeconds,JSON.stringify(assignment.zoneIds.map(id=>this.zones().find(z=>z.id===id)?.name).filter(Boolean)));
          entry.alerted=true;
        }
        this.live.set(session.staff_id,entry);
      }
    });
  }
  report(date=localDate(new Date(this.now()))){
    validDate(date);const assignments=this.assignments();
    const sessions=this.db.prepare("SELECT * FROM attendance_sessions WHERE work_date=? AND source='station'").all(date);
    const rows=this.station.staff().filter(s=>s.active||sessions.some(a=>a.staff_id===s.id)).map(staff=>{
      const own=sessions.filter(s=>s.staff_id===staff.id),assignment=assignments.find(a=>a.staffId===staff.id),totals={inside:0,outside:0,uncertain:0};let elapsed=0;
      for(const session of own){elapsed+=Math.max(0,(session.check_out?Date.parse(session.check_out):this.now())-Date.parse(session.check_in));for(const interval of this.db.prepare('SELECT * FROM work_intervals WHERE session_id=?').all(session.id)){if(interval.state in totals)totals[interval.state]+=Math.max(0,Math.min(interval.end_ms,session.check_out?Date.parse(session.check_out):this.now())-Math.max(interval.start_ms,Date.parse(session.check_in)));}}
      const open=own.find(s=>!s.check_out),current=this.live.get(staff.id),fresh=open&&current?.sessionId===open.id&&this.now()-current.at<=5000;
      const state=this.gathering.mode()==='tabletop'?'tabletop_paused':!assignment?'unconfigured':!open?'session_ended':fresh?current.state:'not_visible';
      return {staffId:staff.id,name:staff.name,code:staff.code,color:assignment?.color||null,state,region:fresh?current.region:'',sessionIds:own.map(s=>s.id),insideSeconds:totals.inside/1000,outsideSeconds:totals.outside/1000,uncertainSeconds:totals.uncertain/1000,unobservedSeconds:Math.max(0,elapsed-totals.inside-totals.outside-totals.uncertain)/1000,outsideRunSeconds:fresh&&current.outsideSince!==null?(current.at-current.outsideSince)/1000:0,allowedSeconds:assignment?.outsideSeconds??null};
    });
    const events=this.db.prepare('SELECT e.*,s.name,s.code FROM work_events e JOIN attendance_sessions a ON a.id=e.session_id JOIN staff s ON s.id=e.staff_id WHERE a.work_date=? ORDER BY e.at DESC').all(date).map(e=>({...e,regions:JSON.parse(e.regions)}));return {date,rows,events};
  }
  timeline(staffId,date){validDate(date);return this.db.prepare('SELECT i.* FROM work_intervals i JOIN attendance_sessions a ON a.id=i.session_id WHERE i.staff_id=? AND a.work_date=? ORDER BY i.start_ms').all(staffId,date);}
  review(id,input){if(!['unreviewed','reviewed','false_match','allowed_task'].includes(input.review)||typeof input.notes!=='string'||input.notes.length>2000)throw Error('Choose a review status and notes up to 2000 characters');if(!this.db.prepare('SELECT id FROM work_events WHERE id=?').get(id))throw Error('Unknown area event');this.db.prepare('UPDATE work_events SET review=?,notes=? WHERE id=?').run(input.review,input.notes,id);return {ok:true};}
}
module.exports={WorkAreaStore,polygon};
