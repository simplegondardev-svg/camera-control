const $ = selector => document.querySelector(selector);
let staff = [], currentStatus, previousState = '', stationBusy = false, enrollmentSignature = '', page = 'station', enrollmentPending = false;
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const checkoutLink=document.createElement('a');checkoutLink.className='nav-item';checkoutLink.href='/checkout.html';checkoutLink.textContent='◷ Checkout review';document.querySelector('nav').append(checkoutLink);
const workLink=document.createElement('a');workLink.className='nav-item';workLink.href='/workareas.html';workLink.textContent='▧ Work areas';document.querySelector('nav').append(workLink);
function dateString(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function time(value) { return value ? new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'; }
function node(tag,text,className) { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; if(className) el.className=className; return el; }
async function api(url,options={}) { const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)}); const result=await response.json(); if(!response.ok) throw Error(result.error || 'Request failed'); return result; }
const post=(url,data={})=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function error(message) { $('#globalError').textContent=message; $('#globalError').hidden=!message; }
function showPage(name) {
  page=name;
  for(const tab of ['station','staff','history']) $(`#${tab}Page`).hidden=tab!==name;
  for(const button of document.querySelectorAll('.nav-item')) { button.classList.toggle('active',button.dataset.tab===name); if(button.dataset.tab===name) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }
  $('#breadcrumb').textContent={station:'Scan station',staff:'Staff & schedules',history:'Attendance log'}[name]; error('');
  if(name==='staff') refreshStaff().catch(e=>error(e.message));
  if(name==='history') refreshHistory().catch(e=>error(e.message));
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>showPage(button.dataset.tab)));
function personCell(row) { const cell=node('td'),wrapper=node('div',undefined,'person-cell'),name=node('div'); name.append(node('strong',row.name),node('small',row.code)); wrapper.append(node('span',row.name.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase(),'avatar'),name); cell.append(wrapper); return cell; }
function attendanceRow(row) {
  const tr=node('tr'); tr.append(personCell(row),node('td',row.schedule),node('td',time(row.arrival)),node('td',time(row.departure)));
  const status=node('td'),type=row.status.includes('Late')||row.status.includes('Missing')?'warn':row.status.startsWith('Checked')?'good':'dim'; status.append(node('span',row.status,'pill '+type));
  const notes=[]; if(row.lateMinutes) notes.push(`${row.lateMinutes} min beyond grace`); if(row.earlyMinutes) notes.push(`${row.earlyMinutes} min early departure`); if(row.source==='legacy') notes.push('Legacy record'); if(notes.length) status.append(node('small',notes.join(' · ')));
  tr.append(status,node('td',row.sessions?`${row.workedMinutes} min`:'—')); return tr;
}
async function refreshToday() {
  const result=await api('/api/attendance/day?date='+dateString()); $('#todayRows').replaceChildren(...result.rows.map(attendanceRow)); $('#todayEmpty').hidden=result.rows.length>0;
  const stats=[['Expected today',result.rows.filter(r=>r.expected).length,'From saved working schedules'],['Checked in',result.rows.filter(r=>r.source==='station'&&r.arrival&&!r.departure).length,'Open attendance sessions'],['Late arrivals',result.rows.filter(r=>r.lateMinutes>0).length,'Beyond the allowed grace period'],['Scans today',result.eventCount,'Confirmed check-ins and checkouts']];
  $('#stationStats').replaceChildren(...stats.map(([label,value,note])=>{const card=node('div',undefined,'stat');card.append(node('p',label),node('strong',String(value)),node('small',note));return card;}));
}
async function refreshHistory() {
  const selected=$('#historyDate').value||dateString(),result=await api('/api/attendance/day?date='+selected); $('#historyRows').replaceChildren(...result.rows.map(attendanceRow)); $('#historyEmpty').hidden=result.rows.length>0; $('#exportCsv').href='/api/attendance/export?date='+selected;
  $('#scanEvents').replaceChildren(...result.events.map(event=>{const item=node('li');item.append(node('span',event.action==='in'?'↘':'↗','event-arrow'),node('strong',event.name),node('span',event.action==='in'?'Checked in':'Checked out'),node('time',time(event.at)));return item;}));
  if(!result.events.length) $('#scanEvents').append(node('li','No confirmed scans on this working date.'));
}
$('#historyDate').value=dateString(); $('#historyDate').addEventListener('change',()=>refreshHistory().catch(e=>error(e.message)));
function renderScan(scan={}) {
  $('#scanResult').className='scan-result '+(scan.state||'idle'); $('#resultIcon').textContent=scan.state==='success'?'✓':scan.state==='error'?'!':'◎';
  $('#resultTitle').textContent=scan.state==='success'?`${scan.name} · ${scan.action==='in'?'Checked in':'Checked out'}`:scan.state==='scanning'?`Scanning for check-${scan.action}`:scan.state==='error'?'Scan not recorded':'Ready when you are';
  $('#resultMessage').textContent=scan.message||'Start the station, then choose Check in or Check out.';
  $('#resultDetail').textContent=scan.state==='success'?[time(scan.at),scan.lateMinutes?`${scan.lateMinutes} min beyond grace`:'',scan.earlyMinutes?`${scan.earlyMinutes} min early departure`:''].filter(Boolean).join(' · '):'';
  $('#cancelScan').hidden=scan.state!=='scanning';
}
function renderStatus(status) {
  currentStatus=status; const running=status.detectionMode==='attendance'&&['running','loading'].includes(status.detection?.state);
  const ready=status.detectionMode==='attendance'&&status.state==='connected'&&status.detection?.state==='running'&&status.recognitionRuntime?.state==='ready'&&status.attendanceEnabled&&!status.pendingEnrollment&&!status.recognitionOnlyMode;
  $('#connectionChip').textContent=status.state==='connected'?'● Camera connected':['connecting','reconnecting'].includes(status.state)?'● Connecting camera':'● Camera offline'; $('#connectionChip').classList.toggle('live',status.state==='connected');
  $('#startStation').textContent=running?'Pause station':'Start station'; $('#startStation').disabled=stationBusy||(!running&&status.state!=='connected');
  $('#checkIn').disabled=$('#checkOut').disabled=!ready||enrollmentPending||status.scan?.state==='scanning'; $('#enrollButton').disabled=!ready||enrollmentPending||!staff.some(person=>person.active);
  $('#scannerBadge').textContent=ready?'Ready to scan':status.detection?.state==='loading'?'Starting scanner':running?'Initializing recognition':'Scanner paused';
  $('#recognitionStatus').textContent=status.recognitionRuntime?.message||status.detection?.message||'Start the station to recognize a face.'; $('#cameraMessage').textContent=status.message||'';
  if(document.activeElement!==$('#livenessToggle')) $('#livenessToggle').checked=status.livenessEnabled===true;
  $('#livenessHint').textContent=status.livenessEnabled?'Liveness screening on. Hold still while the live-face check completes.':'Liveness screening off for testing. Face scans do not verify that a person is live.';
  if(status.state==='connected') { if(previousState!=='connected') $('#streamImage').src='/api/stream?t='+Date.now(); $('#streamImage').hidden=false; $('#emptyState').hidden=true; }
  else { $('#streamImage').hidden=true; $('#streamImage').removeAttribute('src'); $('#emptyState').hidden=false; }
  if(!previousState&&status.state!=='connected') $('#cameraSetup').open=true; previousState=status.state; renderScan(status.scan);
  const enrolled=status.detection?.enrollStatus;
  if(enrolled&&enrolled.at!==enrollmentSignature) { enrollmentSignature=enrolled.at; enrollmentPending=false; $('#enrollStatus').textContent=enrolled.message; refreshStaff().catch(e=>error(e.message)); }
  if(enrollmentPending&&!running) { enrollmentPending=false; $('#enrollStatus').textContent='Scanner stopped. Start the station and retry enrollment.'; }
}
$('#streamImage').addEventListener('load',()=>{const image=$('#streamImage');if(image.naturalWidth) $('#frameMeta').textContent=`${image.naturalWidth} × ${image.naturalHeight}`;}); $('#streamImage').addEventListener('error',()=>{previousState='';});
$('#connectionForm').addEventListener('submit',async event=>{event.preventDefault();$('#connectButton').disabled=true;try{await post('/api/connect',{rtspUrl:$('#rtspUrl').value.trim()});error('');}catch(e){error(e.message);}finally{$('#connectButton').disabled=false;}});
$('#disconnectButton').addEventListener('click',async()=>{try{await post('/api/disconnect');renderStatus(await api('/api/status'));}catch(e){error(e.message);}});
$('#startStation').addEventListener('click',async()=>{stationBusy=true;$('#startStation').disabled=true;try{if(currentStatus?.detectionMode==='attendance'&&['running','loading'].includes(currentStatus?.detection?.state)) await post('/api/detection/stop');else{await post('/api/attendance',{enabled:true});await post('/api/detection/start');}renderStatus(await api('/api/status'));error('');}catch(e){error(e.message);}finally{stationBusy=false;}});
for(const [id,action] of [['checkIn','in'],['checkOut','out']]) $('#'+id).addEventListener('click',async()=>{$('#checkIn').disabled=$('#checkOut').disabled=true;try{renderScan((await post('/api/attendance/scan',{action})).scan);error('');}catch(e){error(e.message);}});
$('#cancelScan').addEventListener('click',async()=>{try{renderScan((await post('/api/attendance/scan/cancel')).scan);}catch(e){error(e.message);}});
$('#livenessToggle').addEventListener('change',async()=>{try{await post('/api/attendance',{livenessEnabled:$('#livenessToggle').checked});}catch(e){error(e.message);$('#livenessToggle').checked=!$('#livenessToggle').checked;}});
function renderStaff() {
  const query=$('#staffSearch').value.trim().toLowerCase(),shown=staff.filter(person=>`${person.name} ${person.code} ${person.department}`.toLowerCase().includes(query));
  $('#staffRows').replaceChildren(...shown.map(person=>{
    const tr=node('tr');tr.append(personCell(person),node('td',person.department||'—'));
    const schedule=node('td',`${person.startTime}–${person.endTime}`);schedule.append(node('small',person.days.map(day=>dayNames[day]).join(', ')+` · ${person.graceMinutes} min grace`));
    const face=node('td');face.append(node('span',!person.active?'Inactive':person.faceSamples?`${person.faceSamples} face samples`:'Not enrolled','pill '+(person.faceSamples&&person.active?'good':'warn')));
    const actions=node('td'),buttons=node('div',undefined,'table-actions'),edit=node('button','Edit','text-button'),enroll=node('button','Enroll face','text-button');edit.addEventListener('click',()=>openStaff(person));enroll.disabled=!person.active;
    enroll.addEventListener('click',()=>{showPage('station');$('#enrollStaff').value=person.id;$('#enrollConsent').checked=false;$('#enrollStatus').textContent=`Ready to enroll ${person.name}. Confirm consent, then capture their face.`;$('#enrollForm').scrollIntoView({behavior:'smooth',block:'center'});});buttons.append(edit,enroll);actions.append(buttons);tr.append(schedule,face,actions);return tr;
  }));
  $('#staffEmpty').hidden=shown.length>0;$('#staffEmpty').textContent=staff.length?'No staff match your search.':'No staff yet. Add a profile and schedule, then enroll their face.';
  const selected=$('#enrollStaff').value;$('#enrollStaff').replaceChildren(node('option','Choose staff member'));$('#enrollStaff').firstChild.value='';
  for(const person of staff.filter(person=>person.active)){const option=node('option',`${person.name} · ${person.code}`);option.value=person.id;$('#enrollStaff').append(option);}if(staff.some(person=>person.id===selected&&person.active)) $('#enrollStaff').value=selected;
}
async function refreshStaff(){staff=(await api('/api/staff')).staff;renderStaff();}
$('#staffSearch').addEventListener('input',renderStaff);
for(const day of [1,2,3,4,5,6,0]){const label=node('label',dayNames[day]),checkbox=node('input');checkbox.type='checkbox';checkbox.value=day;checkbox.checked=day>0&&day<6;label.prepend(checkbox);$('#workingDays').append(label);}
function openStaff(person=null){$('#staffForm').reset();$('#staffId').value=person?.id||'';$('#staffDialogTitle').textContent=person?'Edit staff member':'Add staff member';$('#staffName').value=person?.name||'';$('#staffCode').value=person?.code||'';$('#staffDepartment').value=person?.department||'';$('#shiftStart').value=person?.startTime||'09:00';$('#shiftEnd').value=person?.endTime||'17:00';$('#shiftGrace').value=person?.graceMinutes??5;$('#staffActive').checked=person?.active??true;for(const checkbox of $('#workingDays').querySelectorAll('input'))checkbox.checked=(person?.days||[1,2,3,4,5]).includes(Number(checkbox.value));$('#staffFormError').textContent='';$('#testShiftHint').textContent='One-minute shifts are allowed. An end time before the start means an overnight shift.';$('#staffDialog').showModal();}
$('#addStaff').addEventListener('click',()=>openStaff());for(const id of ['closeStaff','cancelStaff'])$('#'+id).addEventListener('click',()=>$('#staffDialog').close());
$('#testShift').addEventListener('click',()=>{const start=new Date();start.setSeconds(0,0);const end=new Date(start.getTime()+60000),hhmm=date=>`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;$('#shiftStart').value=hhmm(start);$('#shiftEnd').value=hhmm(end);$('#shiftGrace').value=0;for(const checkbox of $('#workingDays').querySelectorAll('input'))checkbox.checked=Number(checkbox.value)===start.getDay();$('#testShiftHint').textContent=`Test shift: ${hhmm(start)}–${hhmm(end)} today, with zero grace. Save, enroll, then scan in and out.`;});
$('#staffForm').addEventListener('submit',async event=>{event.preventDefault();$('#saveStaff').disabled=true;try{const data={name:$('#staffName').value.trim(),code:$('#staffCode').value.trim(),department:$('#staffDepartment').value.trim(),startTime:$('#shiftStart').value,endTime:$('#shiftEnd').value,graceMinutes:Number($('#shiftGrace').value),days:[...$('#workingDays').querySelectorAll('input:checked')].map(input=>Number(input.value)),active:$('#staffActive').checked},id=$('#staffId').value;const saved=await post('/api/staff'+(id?'/'+id:''),data);$('#staffDialog').close();await refreshStaff();await refreshToday();if(!id){$('#enrollStaff').value=saved.staff.id;$('#enrollStatus').textContent=`Saved ${saved.staff.name}. Capture their face at the scan station next.`;}}catch(e){$('#staffFormError').textContent=e.message;}finally{$('#saveStaff').disabled=false;}});
$('#enrollForm').addEventListener('submit',async event=>{event.preventDefault();if(!$('#enrollStaff').value)return;enrollmentPending=true;$('#enrollButton').disabled=true;try{const result=await post('/api/attendance/enroll',{staffId:$('#enrollStaff').value});$('#enrollStatus').textContent=`Enrolling ${result.name}… face the camera and hold still.`;}catch(e){enrollmentPending=false;$('#enrollStatus').textContent=e.message;}});
let pollCount=0;
async function poll(){try{renderStatus(await api('/api/status'));if(pollCount++%3===0){await refreshToday();if(page==='history')await refreshHistory();}}catch(e){error('Attendance service unavailable: '+e.message);$('#checkIn').disabled=$('#checkOut').disabled=true;}setTimeout(poll,800);}
setInterval(()=>{$('#clock').textContent=new Date().toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});},1000);
api('/api/config').then(config=>{$('#rtspUrl').value=config.rtspUrl;}).catch(e=>error(e.message));refreshStaff().catch(e=>error(e.message));const initialTab=new URLSearchParams(location.search).get('tab');if(['staff','history'].includes(initialTab))showPage(initialTab);poll();

const bwNav=document.createElement('a');bwNav.href='/blackwhite.html';bwNav.className='nav-item';bwNav.textContent='Pink & White';document.querySelector('nav').append(bwNav);
