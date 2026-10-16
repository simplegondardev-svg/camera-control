const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StationStore}=require('./station-store'),{WorkAreaStore}=require('./workarea-store');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'preview-timers-')),file=path.join(root,'attendance.sqlite');let now=new Date(2026,9,15,9).getTime();
let station=new StationStore(file),work=new WorkAreaStore(station,{now:()=>now}),store=work.preview;
try{
const zone=work.saveZone({name:'Table left',points:[[0,0],[.5,0],[.5,1],[0,1]]});
assert.throws(()=>store.save({zoneId:zone.id,pink:1,white:0,seconds:5,enabled:true}),/two/);
const mixed=store.save({zoneId:zone.id,pink:1,white:1,seconds:5,enabled:true});assert.throws(()=>work.removeZone(zone.id),/timer/);
const object=(trackId,color,center=[.25,.5])=>({trackId,color,center,stable:true});const pair=[object(1,'pink'),object(2,'white')],start=now;
const tick=(second,items=pair)=>{now=start+second*1000;store.observe(items,now,work.revision());};
for(let i=0;i<=4;i++)tick(i);assert.equal(store.report('2026-10-15').events.length,0);
tick(5,[pair[0],object(2,'white',[.75,.5])]);assert.equal(store.report('2026-10-15').rules[0].elapsedSeconds,0);
for(let i=6;i<=11;i++)tick(i);let event=store.report('2026-10-15').events[0];assert.equal(event.duration_seconds,5);assert(event.active);assert.equal(event.source,'pink_white_test');
tick(12,[...pair,object(3,'pink')]);tick(13);assert.equal(store.report('2026-10-15').events.length,1);
tick(14,[object(4,'pink'),pair[1]]);assert(store.report('2026-10-15').events[0].ended_at,'Replacing a piece ends its cohort');
tick(15,[{...pair[0],stable:false},pair[1]]);assert.equal(store.report('2026-10-15').rules[0].elapsedSeconds,0);
assert(store.report('2026-10-15').rules[0].reason.includes('Pink: 0/1 ready'));
tick(15.5,[pair[0],{...pair[1],stable:false,cropped:true}]);assert(store.report('2026-10-15').rules[0].reason.includes('cropped at camera edge'));
tick(16);tick(30);assert.equal(store.report('2026-10-15').rules[0].elapsedSeconds,0,'Camera gaps reset');
tick(31,[object(1,'pink',[.5,.5]),pair[1]]);assert.equal(store.report('2026-10-15').rules[0].state,'waiting','Boundary centers excluded');
tick(32,[pair[0],pair[0],pair[1]]);assert.equal(store.report('2026-10-15').rules[0].state,'waiting','Duplicates cannot inflate count');
store.save({zoneId:zone.id,pink:3,white:0,seconds:5,enabled:true},mixed.id);
const team=[object(10,'pink'),object(11,'pink'),object(12,'pink')];for(let i=33;i<=38;i++)tick(i,team);
assert.equal(store.report('2026-10-15').events.length,2);store.review(event.id,{review:'expected',notes:'Tabletop rehearsal'});store.pause();assert(store.report('2026-10-15').events.every(e=>!e.active&&e.ended_at));
station.close();station=new StationStore(file);work=new WorkAreaStore(station,{now:()=>now});assert(work.preview.report('2026-10-15').events.some(e=>e.notes==='Tabletop rehearsal'));assert.equal(work.preview.rules()[0].pink,3);
console.log('PASS: mixed/same-color timers, item departure/replacement, extra arrivals, uncertain/boundary/duplicate items, camera gaps, event persistence and review.');
}finally{station.close();}
async function apiChecks(){
  const {spawn}=require('node:child_process');const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'4199',CAMERA_DB_PATH:file,CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true}),base='http://127.0.0.1:4199';
  try{let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'Fixture server starts');
    const report=await (await fetch(base+'/api/blackwhite/gatherings?date=2026-10-15')).json();assert.equal(report.events.length,2);assert.equal(report.rules[0].pink,3);
    const headers={'Content-Type':'application/json'},rule=report.rules[0];
    let response=await fetch(base+'/api/blackwhite/rules/'+rule.id,{method:'POST',headers,body:JSON.stringify({zoneId:rule.zone_id,pink:1,white:1,seconds:5,enabled:true})});assert.equal(response.status,200);
    response=await fetch(base+'/api/blackwhite/rules',{method:'POST',headers,body:JSON.stringify({zoneId:'missing',pink:1,white:1,seconds:5,enabled:true})});assert.equal(response.status,400);
    response=await fetch(base+'/api/blackwhite/events/'+report.events[0].id+'/review',{method:'POST',headers,body:JSON.stringify({review:'reviewed',notes:'API reviewed'})});assert.equal(response.status,200);
    response=await fetch(base+'/api/blackwhite/rules/'+rule.id,{method:'DELETE'});assert.equal(response.status,200);
    console.log('PASS: real-server timer configuration, reports, validation, deletion and review API.');
  }finally{child.kill();}
}
apiChecks().catch(error=>{console.error(error);process.exitCode=1;});
