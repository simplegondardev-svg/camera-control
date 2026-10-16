const {randomUUID}=require('node:crypto');
const {localDate}=require('./attendance');
const {validDate}=require('./station-store');
function inside(point,polygon){let hit=false;const [x,y]=point;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const [ax,ay]=polygon[j],[bx,by]=polygon[i],dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));if(Math.hypot(x-ax-t*dx,y-ay-t*dy)<.015)return false;if((by>y)!==(ay>y)&&x<(ax-bx)*(y-by)/(ay-by)+bx)hit=!hit;}return hit;}
class PreviewGatherings{
  constructor(work){this.work=work;this.db=work.db;this.now=work.now;this.live=new Map();this.last=null;this.items=[];this.ready=[];
    this.db.exec(`CREATE TABLE IF NOT EXISTS preview_gathering_rules(id TEXT PRIMARY KEY,zone_id TEXT NOT NULL REFERENCES work_zones(id),pink INTEGER NOT NULL,white INTEGER NOT NULL,seconds REAL NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preview_gathering_events(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,area TEXT NOT NULL,pink INTEGER NOT NULL,white INTEGER NOT NULL,threshold_seconds REAL NOT NULL,started_at TEXT NOT NULL,confirmed_at TEXT NOT NULL,last_seen TEXT NOT NULL,ended_at TEXT,duration_seconds REAL NOT NULL,review TEXT NOT NULL DEFAULT 'unreviewed',notes TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'pink_white_test');`);
    this.db.prepare('UPDATE preview_gathering_events SET ended_at=last_seen WHERE ended_at IS NULL').run();
  }
  rules(){return this.db.prepare('SELECT * FROM preview_gathering_rules ORDER BY rowid').all().map(r=>({...r,enabled:!!r.enabled}));}
  save(input,id=null){
    if(!this.work.zones().some(z=>z.id===input.zoneId))throw Error('Choose a saved area');
    if(!Number.isInteger(input.pink)||!Number.isInteger(input.white)||input.pink<0||input.white<0||input.pink>50||input.white>50||input.pink+input.white<2)throw Error('Require at least two items total (0 ignores a color)');
    if(!Number.isFinite(input.seconds)||input.seconds<1||input.seconds>3600)throw Error('Duration must be 1–3600 seconds');
    if(typeof input.enabled!=='boolean')throw Error('Choose whether the rule is enabled');
    if(id&&!this.rules().some(r=>r.id===id))throw Error('Unknown timer rule');
    id=id||randomUUID();this.db.prepare('INSERT INTO preview_gathering_rules VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET zone_id=excluded.zone_id,pink=excluded.pink,white=excluded.white,seconds=excluded.seconds,enabled=excluded.enabled').run(id,input.zoneId,input.pink,input.white,input.seconds,+input.enabled);this.work.changed();return this.rules().find(r=>r.id===id);
  }
  remove(id){this.db.prepare('DELETE FROM preview_gathering_rules WHERE id=?').run(id);this.work.changed();}
  finish(entry){if(entry?.eventId)this.db.prepare('UPDATE preview_gathering_events SET ended_at=last_seen WHERE id=?').run(entry.eventId);}
  pause(){for(const e of this.live.values())this.finish(e);this.live.clear();this.last=null;this.items=[];this.ready=[];}
  observe(objects,at,revision){
    if(!Array.isArray(objects)||revision!==this.work.revision()||!Number.isFinite(at)||at>this.now()+1000||this.now()-at>5000){this.pause();return;}
    if(this.last!==null&&at<=this.last)return;
    if(this.last!==null&&at-this.last>3000)this.pause();this.last=at;
    const ids=new Set(),duplicate=new Set();for(const o of objects){if(ids.has(o.trackId))duplicate.add(o.trackId);ids.add(o.trackId);}
    const valid=objects.filter(o=>Number.isInteger(o.trackId)&&!duplicate.has(o.trackId)&&o.stable===true&&['pink','white'].includes(o.color)&&Array.isArray(o.center)&&o.center.length===2&&o.center.every(n=>Number.isFinite(n)&&n>=0&&n<=1));
    this.items=objects.filter(o=>Array.isArray(o.center)&&o.center.length===2&&o.center.every(n=>Number.isFinite(n)&&n>=0&&n<=1));this.ready=valid;
    const zones=this.work.zones();
    this.work.station.transaction(()=>{for(const rule of this.rules()){
      const zone=zones.find(z=>z.id===rule.zone_id),items=zone?valid.filter(o=>inside(o.center,zone.points)):[];
      let entry=this.live.get(rule.id);
      if(!rule.enabled||!zone||['pink','white'].some(c=>items.filter(o=>o.color===c).length<rule[c])){this.finish(entry);this.live.delete(rule.id);continue;}
      const retained=entry&&entry.items.every(p=>items.some(o=>o.trackId===p.trackId&&o.color===p.color));
      if(!retained){this.finish(entry);entry={since:at,last:at,eventId:null,items:['pink','white'].flatMap(c=>items.filter(o=>o.color===c).sort((a,b)=>a.trackId-b.trackId).slice(0,rule[c]).map(o=>({trackId:o.trackId,color:c})))};this.live.set(rule.id,entry);}
      entry.last=at;const duration=(at-entry.since)/1000;
      if(!entry.eventId&&duration>=rule.seconds){entry.eventId=randomUUID();this.db.prepare('INSERT INTO preview_gathering_events(id,rule_id,area,pink,white,threshold_seconds,started_at,confirmed_at,last_seen,duration_seconds) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry.eventId,rule.id,zone.name,rule.pink,rule.white,rule.seconds,new Date(entry.since).toISOString(),new Date(at).toISOString(),new Date(at).toISOString(),duration);}
      else if(entry.eventId)this.db.prepare('UPDATE preview_gathering_events SET last_seen=?,duration_seconds=? WHERE id=?').run(new Date(at).toISOString(),duration,entry.eventId);
    }});
  }
  reason(rule,fresh){
    if(!rule.enabled)return 'Rule disabled';if(!fresh)return 'No recent detection frames. Check the camera connection and start detection.';
    const zone=this.work.zones().find(z=>z.id===rule.zone_id);if(!zone)return 'Area is missing';
    return ['pink','white'].filter(c=>rule[c]>0).map(c=>{const raw=this.items.filter(o=>o.color===c&&inside(o.center,zone.points)),ready=this.ready.filter(o=>o.color===c&&inside(o.center,zone.points)).length,cropped=raw.filter(o=>o.cropped).length,unstable=raw.filter(o=>!o.stable&&!o.cropped).length;return `${c==='pink'?'Pink':'White'}: ${ready}/${rule[c]} ready${cropped?' ('+cropped+' cropped at camera edge)':''}${unstable?' ('+unstable+' still confirming / uncertain)':''}`;}).join(' · ');
  }
  report(date=localDate(new Date(this.now()))){validDate(date);const fresh=this.last!==null&&this.now()-this.last<=5000,zones=this.work.zones();return {rules:this.rules().map(r=>{const entry=fresh?this.live.get(r.id):null;return {...r,reason:this.reason(r,fresh),area:zones.find(z=>z.id===r.zone_id)?.name||'Deleted area',elapsedSeconds:entry?(entry.last-entry.since)/1000:0,state:!r.enabled?'disabled':!fresh?'not_observed':entry?.eventId?'flagged':entry?'timing':'waiting'};}),events:this.db.prepare('SELECT * FROM preview_gathering_events ORDER BY confirmed_at DESC,rowid DESC').all().filter(e=>localDate(new Date(e.started_at))<=date&&localDate(new Date(e.last_seen))>=date).map(e=>({...e,active:fresh&&[...this.live.values()].some(l=>l.eventId===e.id)}))};}
  review(id,input){if(!['unreviewed','reviewed','false_detection','expected'].includes(input.review)||typeof input.notes!=='string'||input.notes.length>2000)throw Error('Choose a review status and notes up to 2000 characters');if(!this.db.prepare('SELECT id FROM preview_gathering_events WHERE id=?').get(id))throw Error('Unknown test event');this.db.prepare('UPDATE preview_gathering_events SET review=?,notes=? WHERE id=?').run(input.review,input.notes,id);return {ok:true};}
}
module.exports={PreviewGatherings,inside};
