const { validDate } = require('./station-store');
const { localDate } = require('./attendance');
class CheckoutStore {
  constructor(station) {
    this.station=station;this.db=station.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkout_events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, started_at TEXT NOT NULL, checkout TEXT NOT NULL,
      duration_seconds REAL NOT NULL, brow_score REAL NOT NULL,
      review TEXT NOT NULL DEFAULT 'unreviewed', category TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', reviewed_at TEXT);
      CREATE INDEX IF NOT EXISTS checkout_events_at ON checkout_events(at);`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(checkout_events)').all().map(row=>row.name));
    for(const [name,type] of [['signal',"TEXT NOT NULL DEFAULT 'brow'"],['mouth_score','REAL NOT NULL DEFAULT 0'],['signal_score','REAL']]) if(!columns.has(name))this.db.exec(`ALTER TABLE checkout_events ADD COLUMN ${name} ${type}`);
  }
  config() { return {signal:'either',...this.station.setting('checkout_config',{checkout:'Checkout 1',zone:null,sustainSeconds:1,threshold:.3,cooldownSeconds:20,revision:0})}; }
  saveConfig(input) {
    const checkout=String(input.checkout??'').trim();
    if(!checkout||checkout.length>60) throw Error('Enter a checkout name (up to 60 characters)');
    const zone=input.zone;
    if(zone!==null && (!zone||['x','y','width','height'].some(key=>typeof zone[key]!=='number'||!Number.isFinite(zone[key]))||zone.x<0||zone.y<0||zone.width<.05||zone.height<.05||zone.x+zone.width>1.000001||zone.y+zone.height>1.000001)) throw Error('Draw a customer zone at least 5% wide and high within the camera image');
    for(const [key,min,max] of [['sustainSeconds',.5,10],['threshold',.05,1],['cooldownSeconds',1,120]]) if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<min||input[key]>max) throw Error(`Invalid ${key}`);
    const signal=input.signal||'either';if(!['brow','mouth','either'].includes(signal))throw Error('Choose brows, mouth, or either');
    const config={checkout,signal,zone:zone?{x:zone.x,y:zone.y,width:zone.width,height:zone.height}:null,sustainSeconds:input.sustainSeconds,threshold:input.threshold,cooldownSeconds:input.cooldownSeconds,revision:this.config().revision+1};
    this.station.setSetting('checkout_config',config);return config;
  }
  add(id,event,config) {
    const score=event.frownScore??event.browScore;
    if(!Number.isFinite(event.confirmedAt)||!Number.isFinite(event.startedAt)||!Number.isFinite(event.durationSeconds)||event.durationSeconds<config.sustainSeconds||!Number.isFinite(score)||score<config.threshold||score>1||!Number.isFinite(event.browScore)||event.browScore<0||event.browScore>1) throw Error('Invalid checkout detection event');
    this.db.prepare('INSERT OR IGNORE INTO checkout_events(id,at,started_at,checkout,duration_seconds,brow_score,signal,mouth_score,signal_score) VALUES (?,?,?,?,?,?,?,?,?)').run(id,new Date(event.confirmedAt).toISOString(),new Date(event.startedAt).toISOString(),config.checkout,event.durationSeconds,event.browScore,event.signal||'brow',event.mouthScore||0,score);
  }
  list(date=localDate(new Date())) {
    validDate(date);const start=new Date(`${date}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
    return this.db.prepare('SELECT * FROM checkout_events WHERE at>=? AND at<? ORDER BY at DESC').all(start.toISOString(),end.toISOString()).map(row=>({id:row.id,at:row.at,startedAt:row.started_at,checkout:row.checkout,durationSeconds:row.duration_seconds,browScore:row.brow_score,mouthScore:row.mouth_score,frownScore:row.signal_score??row.brow_score,signal:row.signal,review:row.review,category:row.category,notes:row.notes,reviewedAt:row.reviewed_at}));
  }
  review(id,input) {
    if(!['unreviewed','reviewed','false_detection','unclear'].includes(input.review)||!['','price_check','payment_retry','queue_delay','other'].includes(input.category)) throw Error('Choose a valid review status and context');
    if(typeof input.notes!=='string'||input.notes.length>4000) throw Error('Notes must be at most 4000 characters');
    if(!this.db.prepare('SELECT id FROM checkout_events WHERE id=?').get(id)) throw Error('Unknown checkout event');
    this.db.prepare('UPDATE checkout_events SET review=?,category=?,notes=?,reviewed_at=? WHERE id=?').run(input.review,input.category,input.notes,new Date().toISOString(),id);
    return {ok:true};
  }
}
module.exports={CheckoutStore};
