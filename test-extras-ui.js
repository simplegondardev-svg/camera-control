// Copy the app to a temporary sandbox: all settings modified here are test-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-extras-test-'));
const base = 'http://127.0.0.1:4190';
let child, browser;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  for (const file of ['server.js', 'evidence.js']) fs.copyFileSync(path.join(__dirname,file),path.join(root,file));
  fs.cpSync(path.join(__dirname,'public'),path.join(root,'public'),{recursive:true});
  child = spawn(process.execPath, [path.join(root,'server.js')], {cwd:root,env:{...process.env,PORT:'4190',CAMERA_DATA_DIR:path.join(root,'clips')},windowsHide:true});
  for (let i=0;i<50;i++) { try { if ((await fetch(base+'/api/status')).ok) break; } catch {} await pause(100); }
  browser = await chromium.launch({channel:'msedge',headless:true});
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.fill('#roleName','Test Cashier');
  await page.fill('#roleColor','#ff0000');
  await page.locator('#roleForm button').click();
  await page.locator('#roleList').getByText('Test Cashier').waitFor();
  await page.reload();
  await page.locator('#roleList').getByText('Test Cashier').waitFor();
  await page.locator('#roleList button').click();
  await page.waitForFunction(()=>document.querySelector('#roleList').children.length===0);
  await page.check('#attendanceToggle');
  await page.waitForResponse(r=>r.url().endsWith('/api/attendance') && r.request().method()==='POST').catch(()=>{});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#attendanceToggle').checked);
  await page.uncheck('#attendanceToggle');
  await pause(300);
  await page.fill('#enrollName','Synthetic fixture');
  await page.locator('#enrollButton').click();
  await page.getByText('Start detection first, then enroll',{exact:true}).waitFor();
  assert(!fs.existsSync(path.join(root,'face-db.json')), 'No face database should be created');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS: add/remove colour roles, role persistence, attendance toggle persistence, and enrollment detection guard. No real settings or face data changed.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  if(browser) await browser.close();
  if(child && child.exitCode===null) {const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
  fs.rmSync(root,{recursive:true,force:true});
});
