const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {chromium}=require('playwright-core');
const {StationStore}=require('./station-store');const {WorkAreaStore}=require('./workarea-store');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-area-test-')),dbFile=path.join(root,'attendance.sqlite');
let now=new Date(2026,9,14,9,0,0).getTime(),station,child,browser;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  station=new StationStore(dbFile,{now:()=>new Date(now)});const work=new WorkAreaStore(station,{now:()=>now});
  const profile={name:'Staff One',code:'STAFF-1',startTime:'09:00',endTime:'17:00',days:[3],graceMinutes:5};
  const first=station.saveStaff(profile),second=station.saveStaff({...profile,name:'Staff Two',code:'STAFF-2'});
  for(const member of [first,second])station.db.prepare('INSERT INTO face_embeddings(staff_id,vector,created_at) VALUES (?,?,?)').run(member.id,Buffer.from(new Float32Array(128).fill(.2).buffer),new Date(now).toISOString());
  const left=work.saveZone({name:'Left counter',points:[[0,0],[.45,0],[.45,1],[0,1]]}),right=work.saveZone({name:'Right counter',points:[[.55,0],[1,0],[1,1],[.55,1]]});
  assert.throws(()=>work.saveZone({name:'Crossed',points:[[0,0],[1,1],[0,1],[1,0]]}));
  work.assign(first.id,{color:'#ff0000',outsideSeconds:5,zoneIds:[left.id]});work.assign(second.id,{color:'#0000ff',outsideSeconds:5,zoneIds:[right.id]});
  assert.throws(()=>work.assign(second.id,{color:'#ff0001',outsideSeconds:5,zoneIds:[right.id]}),/similar/);
  assert.throws(()=>work.removeZone(left.id),/assignments/);
  const in1=station.recordScan(first.id,'in',{score:.9,liveness:'DISABLED'}),in2=station.recordScan(second.id,'in',{score:.9,liveness:'DISABLED'});
  assert.equal(work.workerConfig().staff.length,2);
  const start=now,revision=work.revision();
  function observe(seconds,state){now=start+seconds*1000;work.observe([{staffId:first.id,sessionId:in1.sessionId,state,region:state==='inside'?'Left counter':'Outside'},{staffId:second.id,sessionId:in2.sessionId,state:'inside',region:'Right counter'}],now,revision);}
  observe(0,'inside');observe(1,'inside');observe(2,'outside');observe(3,'outside');observe(4,'outside');observe(5,'uncertain');
  assert.equal(work.report('2026-10-14').events.length,0,'Uncertainty cancels incomplete outside timer');
  for(let second=6;second<=17;second++)observe(second,'outside');
  assert.equal(work.report('2026-10-14').events.length,1,'Only one event per continuous outside run');
  let report=work.report('2026-10-14');assert(report.rows.find(r=>r.staffId===second.id).insideSeconds>10);
  const before=report.rows.find(r=>r.staffId===first.id).outsideSeconds;
  work.pause();now+=10000;report=work.report('2026-10-14');assert.equal(report.rows.find(r=>r.staffId===first.id).outsideSeconds,before);assert(report.rows.find(r=>r.staffId===first.id).unobservedSeconds>=10);
  observe(30,'outside');assert.equal(work.report('2026-10-14').events.length,1,'Gap does not continue old timer');
  const event=work.report('2026-10-14').events[0];work.review(event.id,{review:'allowed_task',notes:'Restocking approved.'});
  now=start+60000;station.recordScan(first.id,'out',{score:.9,liveness:'DISABLED'});station.recordScan(second.id,'out',{score:.9,liveness:'DISABLED'});work.observe([],now,revision);
  assert.equal(work.workerConfig().staff.length,0);assert.equal(work.report('2026-10-14').rows[0].state,'session_ended');assert(work.timeline(first.id,'2026-10-14').length>0);
  station.close();station=new StationStore(dbFile);const restored=new WorkAreaStore(station);assert.equal(restored.report('2026-10-14').events[0].notes,'Restocking approved.');station.close();station=null;
  console.log('PASS: multiple staff/session association, polygons, distinct marker validation, observed intervals, uncertainty/gap handling, outside timer, checkout, timeline and SQLite persistence.');
  const base='http://127.0.0.1:4196';child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'4196',CAMERA_DB_PATH:dbFile,CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true});child.stderr.on('data',data=>process.stderr.write(data));
  for(let i=0;i<40;i++){try{if((await fetch(base+'/api/status')).ok)break;}catch{}await wait(100);}
  assert.equal((await fetch(base+'/api/workareas/start',{method:'POST'})).status,409);assert.equal((await fetch(base+'/api/workareas/report?date=2026-02-30')).status,400);
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/workareas.html');await page.getByRole('heading',{name:'Track work areas'}).waitFor();
  await page.locator('#zoneName').fill('Test full-frame region');await page.getByRole('button',{name:'Full-frame test region'}).click();await page.getByRole('button',{name:'Save region',exact:true}).click();await page.locator('#zoneList').getByText('Test full-frame region',{exact:true}).waitFor();
  await page.locator('#staffSelect').selectOption(first.id);await page.getByRole('button',{name:'Use a 5-second allowance for testing'}).click();await page.locator('#allowedZones').getByText('Test full-frame region',{exact:true}).click();await page.getByRole('button',{name:'Save staff assignment'}).click();
  // Preserve first person's red marker; UI chooses red before saving to avoid second person's blue.
  if(await page.locator('#error').isVisible()){await page.locator('#markerColor').fill('#ff0000');await page.getByRole('button',{name:'Save staff assignment'}).click();}
  await page.getByText('Marker and allowed regions saved.',{exact:true}).waitFor();await page.reload();await page.locator('#zoneList').getByText('Test full-frame region',{exact:true}).waitFor();
  await page.locator('#reportDate').fill('2026-10-14');await page.locator('#reportDate').dispatchEvent('change');await page.getByRole('button',{name:'Review event',exact:true}).waitFor();await page.getByRole('button',{name:'Review event',exact:true}).click();assert.equal(await page.locator('#reviewNotes').inputValue(),'Restocking approved.');await page.locator('#closeReview').click();
  await page.screenshot({path:path.join(__dirname,'.setup','workareas-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile page must not overflow');assert.deepEqual(errors,[]);
  console.log('PASS: work-area API guards, region/assignment creation, 5-second testing option, saved review notes and desktop/mobile UI.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();if(station)station.close();});
