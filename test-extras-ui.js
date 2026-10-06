// Copy the app to a temporary sandbox: all settings modified here are test-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-extras-test-'));
const base = 'http://127.0.0.1:4191';
let child, browser;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  for (const file of ['server.js', 'evidence.js', 'attendance.js']) fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
  fs.cpSync(path.join(__dirname,'public'),path.join(root,'public'),{recursive:true});
  fs.writeFileSync(path.join(root,'attendance-config.json'), JSON.stringify({ enabled: true }, null, 2));
  child = spawn(process.execPath, [path.join(root,'server.js')], {cwd:root,env:{...process.env,PORT:'4191',CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true});
  for (let i=0;i<50;i++) { try { if ((await fetch(base+'/api/status')).ok) break; } catch {} await pause(100); }
  const attendanceResponse = await fetch(base+'/api/attendance/records');
  assert.equal(attendanceResponse.status, 200);
  assert.deepEqual((await attendanceResponse.json()).records, []);
  const initialStatus = await (await fetch(base+'/api/status')).json();
  assert.equal(initialStatus.attendanceEnabled, true);
  assert.equal(initialStatus.livenessEnabled, false);
  assert.equal(initialStatus.attendanceStartTime, '06:00');
  assert.equal(initialStatus.attendanceEndTime, '22:00');
  assert.equal(typeof initialStatus.attendanceWindowActive, 'boolean');
  const scheduleResponse = await fetch(base+'/api/attendance', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ attendanceStartTime:'07:15', attendanceEndTime:'21:30' }),
  });
  assert.equal(scheduleResponse.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8')), {
    enabled:true,
    livenessEnabled:false,
    attendanceStartTime:'07:15',
    attendanceEndTime:'21:30',
  });
  const invalidScheduleResponse = await fetch(base+'/api/attendance', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ attendanceEndTime:'06:00' }),
  });
  assert.equal(invalidScheduleResponse.status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8')), {
    enabled:true,
    livenessEnabled:false,
    attendanceStartTime:'07:15',
    attendanceEndTime:'21:30',
  });
  const serverExited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await serverExited;
  child = spawn(process.execPath, [path.join(root,'server.js')], {cwd:root,env:{...process.env,PORT:'4191',CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true});
  let restartedStatus;
  for (let i=0;i<50;i++) {
    try {
      const response = await fetch(base+'/api/status');
      if (response.ok) { restartedStatus = await response.json(); break; }
    } catch {}
    await pause(100);
  }
  assert(restartedStatus, 'Server should restart with the saved schedule');
  assert.equal(restartedStatus.attendanceEnabled, true);
  assert.equal(restartedStatus.livenessEnabled, false);
  assert.equal(restartedStatus.attendanceStartTime, '07:15');
  assert.equal(restartedStatus.attendanceEndTime, '21:30');
  browser = await chromium.launch({channel:'msedge',headless:true});
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.getByText('No attendance records yet.', { exact: true }).waitFor();
  assert.equal(await page.locator('#livenessToggle').isChecked(), false);
  assert.equal(await page.locator('#attendanceStartTime').inputValue(), '07:15');
  assert.equal(await page.locator('#attendanceEndTime').inputValue(), '21:30');
  assert.match(await page.locator('#attendanceEnabledStatus').textContent(), /enabled/i);
  assert.match(await page.locator('#attendanceWindowStatus').textContent(), /Outside attendance window|Inside attendance window/);
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    (async () => {
      await page.fill('#attendanceStartTime','08:30');
      await page.locator('#attendanceStartTime').press('Tab');
    })(),
  ]);
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    (async () => {
      await page.fill('#attendanceEndTime','21:45');
      await page.locator('#attendanceEndTime').press('Tab');
    })(),
  ]);
  let config = JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8'));
  assert.deepEqual(config, {
    enabled:true,
    livenessEnabled:false,
    attendanceStartTime:'08:30',
    attendanceEndTime:'21:45',
  });
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#attendanceStartTime').value === '08:30' &&
    document.querySelector('#attendanceEndTime').value === '21:45');
  await page.getByText('Liveness screening OFF — recognition does not verify that a face is live.', { exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    page.check('#livenessToggle'),
  ]);
  config = JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8'));
  assert.deepEqual(config, {
    enabled: true, livenessEnabled: true,
    attendanceStartTime: '08:30', attendanceEndTime: '21:45',
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#livenessToggle').checked);
  await page.getByText('Liveness screening ON — recognition and attendance require a stable LIVE result.', { exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    page.uncheck('#livenessToggle'),
  ]);
  config = JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8'));
  assert.deepEqual(config, {
    enabled: true, livenessEnabled: false,
    attendanceStartTime: '08:30', attendanceEndTime: '21:45',
  });
  await page.fill('#roleName','Test Cashier');
  await page.fill('#roleColor','#ff0000');
  await page.locator('#roleForm button').click();
  await page.locator('#roleList').getByText('Test Cashier').waitFor();
  await page.reload();
  await page.locator('#roleList').getByText('Test Cashier').waitFor();
  await page.locator('#roleList button').click();
  await page.waitForFunction(()=>document.querySelector('#roleList').children.length===0);
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    page.uncheck('#attendanceToggle'),
  ]);
  config = JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8'));
  assert.deepEqual(config, {
    enabled: false, livenessEnabled: false,
    attendanceStartTime: '08:30', attendanceEndTime: '21:45',
  });
  await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST'),
    page.check('#attendanceToggle'),
  ]);
  config = JSON.parse(fs.readFileSync(path.join(root,'attendance-config.json'),'utf8'));
  assert.deepEqual(config, {
    enabled: true, livenessEnabled: false,
    attendanceStartTime: '08:30', attendanceEndTime: '21:45',
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#attendanceToggle').checked);
  await page.uncheck('#attendanceToggle');
  await pause(300);
  await page.fill('#enrollName','Synthetic fixture');
  await page.locator('#enrollButton').click();
  await page.getByText('Start detection first, then enroll',{exact:true}).waitFor();
  assert(!fs.existsSync(path.join(root,'face-db.json')), 'No face database should be created');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS: attendance schedule defaults, validates, persists across restart, and is editable in the UI; liveness defaults OFF and persists; attendance toggle preserves schedule/liveness; roles persist and enrollment guard remains.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  if(browser) await browser.close();
  if(child && child.exitCode===null) {const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
  fs.rmSync(root,{recursive:true,force:true});
});
