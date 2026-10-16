const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { StationStore, scheduleFor } = require('./station-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-station-test-'));
const file = path.join(root, 'attendance.sqlite');
let now = new Date(2026,9,14,9,0,0), store, child, browser;
const profile = {code:'EMP-001',name:'Test Staff',department:'Operations',startTime:'09:00',endTime:'09:01',graceMinutes:0,days:[3]};
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
function enrollFixture(person) { store.db.prepare('INSERT INTO face_embeddings(staff_id,vector,created_at) VALUES (?,?,?)').run(person.id,Buffer.from(new Float32Array(128).fill(1).buffer),now.toISOString()); }
function confirm(face) { for(let i=0;i<3;i++){store.observe([face],{livenessEnabled:false});now=new Date(now.getTime()+500);} }
async function main() {
  store = new StationStore(file,{now:()=>now});
  const person = store.saveStaff(profile); enrollFixture(person);
  const face = {staffId:person.id,name:person.name,score:.9,liveness:'DISABLED'};
  confirm(face); assert.equal(store.list().length,0,'Unarmed sightings cannot create attendance');
  now = new Date(2026,9,14,9,0,0); store.arm('in'); confirm(face);
  assert.equal(store.scanStatus().state,'success'); assert.equal(store.list().length,1);
  assert.equal(store.eventCount('2026-10-14'),1);
  now = new Date(2026,9,14,9,0,5); store.arm('in'); confirm(face);
  assert.equal(store.scanStatus().state,'error'); assert.equal(store.eventCount('2026-10-14'),1,'Duplicate check-in adds no event');
  now = new Date(2026,9,14,9,1,1); store.arm('out'); confirm(face);
  assert.equal(store.scanStatus().state,'success');
  assert.equal(store.daily('2026-10-14')[0].workedMinutes,1);
  assert.equal(store.daily('2026-10-14')[0].earlyMinutes,0);
  assert.equal(store.eventCount('2026-10-14'),2);
  store.arm('out'); confirm(face); assert.equal(store.scanStatus().state,'error');
  store.arm('in'); now=new Date(now.getTime()+21000); assert.equal(store.scanStatus().state,'idle','Armed scans expire');
  store.arm('in'); store.observe([{...face,liveness:'LIVE'}],{livenessEnabled:false}); assert.equal(store.candidate,null);
  store.observe([face,face],{livenessEnabled:false}); assert.equal(store.candidate,null,'Multiple faces cannot scan');
  store.cancel();
  assert.throws(()=>store.saveStaff({...profile,code:'emp-001'}),/already in use/);
  assert.throws(()=>store.saveStaff({...profile,code:'INVALID',endTime:'09:00'}),/different shift/);
  const late = store.saveStaff({...profile,code:'LATE',name:'Late staff',graceMinutes:5,endTime:'17:00'}); enrollFixture(late);
  now=new Date(2026,9,14,9,6,0); const lateResult=store.recordScan(late.id,'in',{score:.9,liveness:'DISABLED'}); assert.equal(lateResult.lateMinutes,1);
  store.saveStaff({...profile,code:'LATE',name:'Late staff',graceMinutes:60,endTime:'17:00'},late.id);
  assert.equal(store.daily('2026-10-14').find(row=>row.staffId===late.id).lateMinutes,1,'Schedule edits cannot rewrite stored lateness');
  const overnight={...profile,startTime:'23:59',endTime:'00:00',days:[3]};
  const overnightShift=scheduleFor(overnight,new Date(2026,9,14,23,59,0)); assert.equal(overnightShift.end-overnightShift.start,60000);
  const night = store.saveStaff({...profile,code:'NIGHT',name:'Night staff',startTime:'22:00',endTime:'06:00'}); enrollFixture(night);
  now=new Date(2026,9,14,22,0,0);store.recordScan(night.id,'in',{score:.9,liveness:'DISABLED'});
  now=new Date(2026,9,15,6,0,0);store.recordScan(night.id,'out',{score:.9,liveness:'DISABLED'});
  assert.equal(store.daily('2026-10-14').find(row=>row.staffId===night.id).workedMinutes,480,'Overnight checkout belongs to original work date');
  store.close();store=new StationStore(file);assert.equal(store.eventCount('2026-10-14'),5);store.close();store=null;
  // Legacy import is atomic and idempotent, and never edits the original files.
  const legacyRoot=path.join(root,'legacy');fs.mkdirSync(legacyRoot);
  const legacyFaces=JSON.stringify({'Imported person':[Array(128).fill(.2)]});fs.writeFileSync(path.join(legacyRoot,'face-db.json'),legacyFaces);
  fs.writeFileSync(path.join(legacyRoot,'attendance-records.json'),JSON.stringify([{person:'Imported person',date:'2026-10-13',arrival:'2026-10-13T06:00:00Z',departure:null}]));
  const imported=new StationStore(path.join(legacyRoot,'attendance.sqlite'),{legacyDir:legacyRoot});assert.equal(imported.staff().length,1);assert.equal(imported.staff()[0].faceSamples,1);assert.equal(imported.list().length,1);imported.migrate(legacyRoot);assert.equal(imported.list().length,1);imported.close();assert.equal(fs.readFileSync(path.join(legacyRoot,'face-db.json'),'utf8'),legacyFaces);
  console.log('PASS: intentional scans, stability, duplicates, one-minute/overnight shifts, lateness snapshots, SQLite persistence and legacy migration.');
  const base='http://127.0.0.1:4194';
  child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'4194',CAMERA_DB_PATH:file,CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true});
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  for(let i=0;i<40;i++){try{if((await fetch(base+'/api/status')).ok)break;}catch{}await wait(100);}
  assert.equal((await fetch(base+'/api/attendance/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'in'})})).status,409);
  assert.equal((await fetch(base+'/api/attendance/day?date=2026-02-30')).status,400);
  const csv=await fetch(base+'/api/attendance/export?date=2026-10-14');assert.equal(csv.status,200);assert((await csv.text()).includes('Test Staff'));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  await page.getByRole('heading',{name:'Ready for the working day.'}).waitFor();
  await page.locator('.nav-item[data-tab="staff"]').click();await page.getByRole('button',{name:'+ Add staff member'}).click();
  await page.locator('#staffName').fill('UI test person');await page.locator('#staffCode').fill('UI-001');await page.getByRole('button',{name:'Use a one-minute test shift'}).click();
  const start=await page.locator('#shiftStart').inputValue(),end=await page.locator('#shiftEnd').inputValue();
  const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3));assert.equal((minute(end)-minute(start)+1440)%1440,1);
  await page.getByRole('button',{name:'Save staff member',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#staffDialog').open);
  await page.locator('#staffRows').getByText('UI test person',{exact:true}).waitFor();await page.reload();await page.locator('.nav-item[data-tab="staff"]').click();await page.locator('#staffRows').getByText('UI test person',{exact:true}).waitFor();
  await page.locator('.nav-item[data-tab="station"]').click();await page.screenshot({path:path.join(__dirname,'.setup','attendance-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(__dirname,'.setup','attendance-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile layout must not overflow');assert.deepEqual(errors,[]);
  console.log('PASS: attendance API validation, CSV, staff creation, one-minute form shortcut, reload persistence and desktop/mobile UI.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(child)child.kill();if(store)store.close();});
