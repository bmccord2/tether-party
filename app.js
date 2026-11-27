'use strict';
{
const $ = s => document.querySelector(s);
const app = $('#app'), modal = $('#modal'), toastEl = $('#toast');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rid = () => Math.random().toString(36).slice(2, 8);
const now = () => performance.now();
const ME = 'h';
let myName = ''; try { myName = localStorage.getItem('tp.name') || ''; } catch (e) {}

const Net = { host: false, toHost: null, pc: null };
const H = { players: [], game: null, key: null, opts: {}, pending: null };
let VIEW = null, YOU = null;

function toast(m) { toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('on'), 2600); }

let wl = null;
async function wake() { try { if (navigator.wakeLock) wl = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (Net.host || Net.toHost)) wake(); });

/* ---------- compact SDP codes (fit in a small QR) ---------- */
function pack(sdp, kind) {
  const get = k => { const m = sdp.match(new RegExp('^a=' + k + ':(.+)$', 'm')); return m ? m[1].trim() : ''; };
  const fp = (get('fingerprint').split(' ')[1] || '');
  const fpb = btoa(String.fromCharCode(...fp.split(':').map(h => parseInt(h, 16))));
  const setup = { actpass: 'a', active: 'c', passive: 'p' }[get('setup')] || 'a';
  const seen = new Set(), cs = [];
  for (const m of sdp.matchAll(/^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/gm)) {
    if (m[2] !== '1' || m[3].toLowerCase() !== 'udp') continue;
    const k = m[5] + ' ' + m[6]; if (seen.has(k)) continue; seen.add(k);
    cs.push({ k, r: /^\d+\.\d+\.\d+\.\d+$/.test(m[5]) ? 0 : m[5].endsWith('.local') ? 1 : 2 });
  }
  cs.sort((a, b) => a.r - b.r);
  return [kind, setup, get('ice-ufrag'), get('ice-pwd'), fpb, get('mid') || '0', cs.slice(0, 8).map(c => c.k).join(',')].join('|');
}
function unpack(code) {
  const p = String(code).trim().split('|');
  if (p.length < 7 || (p[0] !== 'O' && p[0] !== 'A')) throw new Error('That QR isn’t a Tether Party code.');
  const [kind, setup, uf, pw, fpb, mid, cl] = p;
  const fp = [...atob(fpb)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const L = ['v=0', 'o=- ' + (Date.now() % 1e9) + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE ' + mid, 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:' + uf, 'a=ice-pwd:' + pw, 'a=ice-options:trickle', 'a=fingerprint:sha-256 ' + fp,
    'a=setup:' + ({ a: 'actpass', c: 'active', p: 'passive' }[setup]), 'a=mid:' + mid, 'a=sctp-port:5000', 'a=max-message-size:262144'];
  (cl ? cl.split(',') : []).forEach((c, i) => { const [a, port] = c.split(' '); L.push(`a=candidate:${i + 1} 1 udp ${2122260223 - i * 256} ${a} ${port} typ host`); });
  return { kind, sdp: L.join('\r\n') + '\r\n' };
}
const gathered = pc => new Promise(r => {
  if (pc.iceGatheringState === 'complete') return r();
  const t = setTimeout(r, 2500);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } });
});

/* ---------- host networking ---------- */
async function hostOffer() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('g', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { pc, dc, code: pack(pc.localDescription.sdp, 'O') };
}
function hostAttach(pc, dc) {
  const id = rid(); let joined = false, gone = false;
  const bye = () => { if (gone) return; gone = true; if (joined) dropPlayer(id); };
  dc.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.t === 'join' && !joined) { joined = true; addPlayer(id, m.name, dc, pc); } else if (joined) hostRecv(id, m); };
  dc.onclose = bye;
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') bye(); };
}
function addPlayer(id, name, dc, pc) {
  name = String(name || 'Player').trim().slice(0, 16) || 'Player';
  let n = name, k = 2; while (H.players.some(p => p.name === n)) n = name + ' ' + (k++);
  H.players.push({ id, name: n, score: 0, dc, pc });
  toast(n + ' joined');
  if (H.pending && H.pending.pc === pc) addDone(n);
  pushViews();
}
function dropPlayer(id) {
  const i = H.players.findIndex(p => p.id === id); if (i < 0) return;
  const [p] = H.players.splice(i, 1); try { p.pc.close(); } catch (e) {}
  toast(p.name + ' left');
  if (H.game && H.game.leave) H.game.leave(id);
  pushViews();
}
function hostSend(pid, m) {
  if (pid === ME) { queueMicrotask(() => clientRecv(m)); return; }
  const p = H.players.find(x => x.id === pid);
  if (p && p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(m)); } catch (e) {} }
}
function toHost(m) {
  if (Net.host) queueMicrotask(() => hostRecv(ME, m));
  else if (Net.toHost && Net.toHost.readyState === 'open') Net.toHost.send(JSON.stringify(m));
}
const act = a => toHost({ t: 'act', a });
function hostRecv(pid, m) { if (m.t === 'act' && H.game) H.game.act(pid, m.a || {}); }
function pushViews() {
  if (!Net.host) return;
  for (const p of H.players) hostSend(p.id, { t: 'view', you: p.id, v: H.game ? H.game.view(p.id) : lobbyView() });
}
const lobbyView = () => ({ k: 'lobby', players: H.players.map(p => ({ id: p.id, name: p.name, score: p.score })) });
function award(pts) { for (const p of H.players) p.score += pts[p.id] || 0; }
function board(pts, ids) { return H.players.filter(p => ids.has(p.id)).map(p => ({ id: p.id, name: p.name, pts: pts[p.id] || 0 })).sort((a, b) => b.pts - a.pts); }

/* ---------- client networking ---------- */
async function clientAnswer(code) {
  const { kind, sdp } = unpack(code);
  if (kind !== 'O') throw new Error('That’s a reply code. Scan the invite on the host’s phone.');
  const pc = new RTCPeerConnection({ iceServers: [] });
  Net.pc = pc;
  pc.ondatachannel = e => {
    const dc = e.channel; Net.toHost = dc;
    const open = () => {
      const hello = () => { if (dc.readyState === 'open' && !VIEW) { dc.send(JSON.stringify({ t: 'join', name: myName })); setTimeout(hello, 1200); } };
      hello(); joinedHost();
    };
    if (dc.readyState === 'open') open(); else dc.onopen = open;
    dc.onmessage = ev => { try { clientRecv(JSON.parse(ev.data)); } catch (x) {} };
    dc.onclose = lost;
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') lost(); };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return pack(pc.localDescription.sdp, 'A');
}
function clientRecv(m) { if (m.t === 'view') { VIEW = m.v; YOU = m.you; render(); } }

/* ---------- camera + QR ---------- */
const Cam = { stream: null, stop: null };
async function camOn(video) {
  if (!Cam.stream) Cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  if (video) { video.srcObject = Cam.stream; video.muted = true; video.setAttribute('playsinline', ''); await video.play().catch(() => {}); }
}
function camOff() { stopScan(); if (Cam.stream) Cam.stream.getTracks().forEach(t => t.stop()); Cam.stream = null; }
function stopScan() { if (Cam.stop) Cam.stop(); Cam.stop = null; }
function scan(video, onCode) {
  stopScan();
  let alive = true, busy = false, det = null;
  if ('BarcodeDetector' in window) { try { det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {} }
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  const step = async () => {
    if (!alive) return;
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      busy = true;
      try {
        let txt = null;
        if (det) { const r = await det.detect(video); if (r[0]) txt = r[0].rawValue; }
        else {
          const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          cv.width = video.videoWidth * s | 0; cv.height = video.videoHeight * s | 0;
          cx.drawImage(video, 0, 0, cv.width, cv.height);
          const d = cx.getImageData(0, 0, cv.width, cv.height);
          const r = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' });
          if (r) txt = r.data;
        }
        if (txt && alive && onCode(txt) === true) alive = false;
      } catch (e) {}
      busy = false;
    }
    if (alive) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  Cam.stop = () => { alive = false; };
}
function qrSVG(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 3, scalable: true }); }
const codeBox = code => `<details class="alt"><summary>Can’t scan? Use the text code</summary><textarea readonly rows="3">${esc(code)}</textarea><button class="ghost sm" data-copy>Copy code</button></details>`;
const pasteBox = label => `<details class="alt"><summary>Can’t scan? Paste a code</summary><textarea id="paste" rows="3" placeholder="${esc(label)}"></textarea><button class="ghost sm" id="usePaste">Use this code</button></details>`;
const camBox = `<div class="cam"><video id="vid" playsinline muted></video><div class="reticle"></div></div>`;
const setSt = t => { const e = $('#st'); if (e) e.textContent = t; };

/* ---------- home / join screens ---------- */
const TILES = `<div class="logo" aria-hidden="true"><i class="t0"></i><i class="t1"></i><i class="t2"></i><i class="t3"></i></div>`;
function home() {
  Net.host = false; Net.toHost = null; VIEW = null; hideModal(); camOff();
  app.innerHTML = `<section class="home">${TILES}
    <h1>Tether Party</h1>
    <p class="lead">Party games across phones. No internet, no app store — just a hotspot.</p>
    <label class="fld"><span>Your name</span><input id="nm" maxlength="16" autocomplete="off" value="${esc(myName)}" placeholder="Your name"></label>
    <div class="row2"><button class="big b0" id="hostBtn">Host a game</button><button class="big b1" id="joinBtn">Join a game</button></div>
    <details class="how"><summary>How connecting works</summary><ol>
      <li>One phone turns on its <b>personal hotspot</b>; everyone else joins that Wi-Fi. (Or all join the same Wi-Fi.) Internet isn’t needed.</li>
      <li>The host taps <b>Add player</b> and shows an invite QR. The new player taps <b>Join</b> and scans it.</li>
      <li>The joiner’s phone shows a reply QR. The host scans it. Connected.</li>
      <li>Keep screens on — a locked phone drops out.</li></ol></details>
  </section>`;
  $('#hostBtn').onclick = () => { if (takeName()) startHost(); };
  $('#joinBtn').onclick = () => { if (takeName()) joinFlow(); };
}
function takeName() {
  const v = $('#nm').value.trim();
  if (!v) { $('#nm').focus(); toast('Enter your name first'); return false; }
  myName = v.slice(0, 16); try { localStorage.setItem('tp.name', myName); } catch (e) {}
  return true;
}
function startHost() { Net.host = true; H.players = [{ id: ME, name: myName, score: 0 }]; H.game = null; wake(); pushViews(); }

function joinFlow() {
  Net.host = false; wake();
  try { Net.pc && Net.pc.close(); } catch (e) {}
  app.innerHTML = `<section class="pane"><h2>Scan the host’s invite</h2>${camBox}
    <p class="muted" id="st">Starting camera…</p>${pasteBox('Paste the invite code')}
    <button class="ghost" id="back">Back</button></section>`;
  $('#back').onclick = home;
  $('#usePaste').onclick = () => gotInvite($('#paste').value);
  const vid = $('#vid');
  camOn(vid).then(() => { setSt('Point at the QR on the host’s phone.');
    scan(vid, t => { if (t.startsWith('O|')) { gotInvite(t); return true; } setSt(t.startsWith('A|') ? 'That’s a reply code — scan the host’s invite.' : 'Not a Tether Party code.'); return false; });
  }).catch(() => setSt('Camera unavailable — paste the invite code below instead.'));
}
let joinWait = null;
async function gotInvite(code) {
  stopScan(); let reply;
  setSt('Preparing reply…');
  try { reply = await clientAnswer(code); }
  catch (e) { setSt(e.message || 'That code didn’t work.'); const v = $('#vid'); if (v && Cam.stream) scan(v, t => t.startsWith('O|') ? (gotInvite(t), true) : false); return; }
  camOff();
  if (Net.toHost && Net.toHost.readyState === 'open') return;
  app.innerHTML = `<section class="pane"><h2>Show this to the host</h2>
    <p class="muted">They tap “Scan their reply” and point their camera here.</p>
    <div class="qr">${qrSVG(reply)}</div>
    <p class="wait"><span class="spin sm"></span><span id="st">Waiting for the host…</span></p>${codeBox(reply)}
    <button class="ghost" id="back">Cancel</button></section>`;
  $('#back').onclick = home;
  clearTimeout(joinWait);
  joinWait = setTimeout(() => setSt('Still waiting. Both phones must be on the same hotspot or Wi-Fi.'), 30000);
}
function joinedHost() {
  clearTimeout(joinWait);
  app.innerHTML = `<section class="pane center"><div class="spin"></div><h2>Connected!</h2><p class="muted">Loading the lobby…</p></section>`;
}
function lost() {
  if (Net.host || !Net.toHost) return;
  Net.toHost = null; VIEW = null;
  app.innerHTML = `<section class="pane center"><h2>Lost the host</h2>
    <p class="muted">The link drops if the host’s screen locks, the app closes or someone leaves the hotspot. Get a fresh invite to rejoin.</p>
    <button class="big b1" id="rj">Rejoin</button><button class="ghost" id="hm">Home</button></section>`;
  $('#rj').onclick = joinFlow; $('#hm').onclick = home;
}

/* ---------- host: add-player modal ---------- */
function showModal(html) { modal.innerHTML = `<div class="sheet">${html}</div>`; modal.hidden = false; }
function hideModal() { modal.hidden = true; modal.innerHTML = ''; }
async function addFlow() {
  stopScan();
  if (H.pending && !H.pending.done) { try { H.pending.pc.close(); } catch (e) {} }
  H.pending = null;
  showModal(`<h2>Add a player</h2><div class="spin"></div><p class="muted center">Making an invite…</p>`);
  try { await camOn(); } catch (e) {}   // camera permission lets WebRTC use real LAN addresses
  let o; try { o = await hostOffer(); } catch (e) { showModal(`<h2>Couldn’t create an invite</h2><p class="muted">${esc(e.message)}</p><button class="ghost" id="x">Close</button>`); $('#x').onclick = closeAdd; return; }
  H.pending = o; hostAttach(o.pc, o.dc);
  inviteStep();
}
function inviteStep() {
  stopScan();
  const o = H.pending; if (!o) return;
  showModal(`<h2>Add a player</h2><p class="muted">On their phone: <b>Join a game</b>, then scan this.</p>
    <div class="qr">${qrSVG(o.code)}</div>
    <button class="big b3" id="toScan">Next: scan their reply</button>${codeBox(o.code)}
    <button class="ghost" id="x">Cancel</button>`);
  $('#toScan').onclick = scanStep; $('#x').onclick = closeAdd;
}
function scanStep() {
  showModal(`<h2>Scan their reply</h2>${camBox}<p class="muted" id="st">Point at the QR on their phone.</p>
    ${pasteBox('Paste the reply code')}<button class="ghost" id="bk">Back to invite</button>`);
  $('#bk').onclick = inviteStep;
  $('#usePaste').onclick = () => applyAnswer($('#paste').value);
  const vid = $('#vid');
  camOn(vid).then(() => scan(vid, t => { if (t.startsWith('A|')) { applyAnswer(t); return true; } setSt(t.startsWith('O|') ? 'That’s your own invite — scan their reply.' : 'Not a Tether Party code.'); return false; }))
    .catch(() => setSt('Camera unavailable — paste their reply code below.'));
}
async function applyAnswer(code) {
  const o = H.pending; if (!o) return;
  stopScan();
  let u; try { u = unpack(code); if (u.kind !== 'A') throw new Error('That’s an invite code — scan the joining phone’s reply.'); }
  catch (e) { setSt(e.message); const v = $('#vid'); if (v && Cam.stream) scan(v, t => t.startsWith('A|') ? (applyAnswer(t), true) : false); return; }
  showModal(`<h2>Connecting…</h2><div class="spin"></div><p class="muted center">Both phones need to be on the same hotspot or Wi-Fi.</p><button class="ghost" id="x">Cancel</button>`);
  $('#x').onclick = closeAdd;
  try { await o.pc.setRemoteDescription({ type: 'answer', sdp: u.sdp }); }
  catch (e) { showModal(`<h2>That reply didn’t match</h2><p class="muted">Make a fresh invite and try again.</p><button class="big b3" id="re">New invite</button><button class="ghost" id="x">Close</button>`); $('#re').onclick = addFlow; $('#x').onclick = closeAdd; return; }
  o.to = setTimeout(() => {
    if (H.pending !== o || o.done) return;
    showModal(`<h2>Couldn’t connect</h2><p class="muted">Check that both phones are on the same hotspot or Wi-Fi network, with screens on. Some networks (guest/hotel Wi-Fi) block phone-to-phone traffic — a phone hotspot avoids that.</p>
      <button class="big b3" id="re">Try again</button><button class="ghost" id="x">Close</button>`);
    $('#re').onclick = addFlow; $('#x').onclick = closeAdd;
  }, 15000);
}
function addDone(name) {
  const o = H.pending; o.done = true; clearTimeout(o.to); H.pending = null; stopScan();
  showModal(`<h2>${esc(name)} is in!</h2><button class="big b3" id="more">Add another player</button><button class="ghost" id="x">Done</button>`);
  $('#more').onclick = addFlow; $('#x').onclick = closeAdd;
}
function closeAdd() {
  stopScan();
  if (H.pending && !H.pending.done) { clearTimeout(H.pending.to); try { H.pending.pc.close(); } catch (e) {} }
  H.pending = null; camOff(); hideModal();
}

/* ---------- games (run on host) ---------- */
const GAMES = {
  trivia: { name: 'Trivia Blitz', min: 1, desc: 'Kahoot-style. Everyone answers on their own phone — faster right answers score more.',
    opts: [['n', 'Questions', ['10', '15', '20']], ['t', 'Seconds', ['20', '15', '30']]], make: o => Trivia(o) },
  imposter: { name: 'Imposter', min: 3, desc: 'Everyone gets the secret word except the imposter. Say one-word clues out loud, then vote.',
    opts: [['hint', 'Imposter sees category', ['Yes', 'No']]], make: o => Imposter(o) },
  reaction: { name: 'Quick Draw', min: 1, desc: 'Wait for green, then tap. Jump early and you score nothing.',
    opts: [['r', 'Rounds', ['5', '3', '10']]], make: o => Reaction(o) }
};
function startGame(key) {
  const g = GAMES[key]; if (!g) return;
  if (H.players.length < g.min) { toast(g.name + ' needs ' + g.min + '+ players'); return; }
  if (H.game && H.game.stop) H.game.stop();
  H.key = key; H.opts[key] = H.opts[key] || {};
  g.opts.forEach(([k, , vals]) => { if (!H.opts[key][k]) H.opts[key][k] = vals[0]; });
  H.game = g.make(H.opts[key]); H.game.start();
}
function toLobby() { if (H.game && H.game.stop) H.game.stop(); H.game = null; pushViews(); }

function Trivia(o) {
  const gid = rid(), LIM = (+o.t || 20) * 1000, N = +o.n || 10;
  const qs = shuffle(window.QUESTIONS).slice(0, N).map(r => { const ord = shuffle([0, 1, 2, 3]); return { q: r[0], opts: ord.map(k => r[1 + k]), ans: ord.indexOf(0), cat: r[5] }; });
  const ids = new Set(H.players.map(p => p.id)), pts = {}; ids.forEach(id => pts[id] = 0);
  let i = -1, phase = '', ans = {}, gains = {}, tm = null, end = 0;
  const live = () => H.players.filter(p => ids.has(p.id));
  function next() { clearTimeout(tm); i++;
    if (i >= qs.length) { phase = 'final'; award(pts); pushViews(); return; }
    phase = 'q'; ans = {}; end = now() + LIM; tm = setTimeout(reveal, LIM + 600); pushViews(); }
  function reveal() { if (phase !== 'q') return; clearTimeout(tm); phase = 'rev'; gains = {};
    const q = qs[i];
    for (const id of ids) { const a = ans[id]; const g = a && a.c === q.ans ? Math.round(1000 - 500 * a.ms / LIM) : 0; gains[id] = g; pts[id] += g; }
    end = now() + 5000; tm = setTimeout(next, 5000); pushViews(); }
  const check = () => { if (live().every(p => ans[p.id])) reveal(); else pushViews(); };
  return { start: next, stop() { clearTimeout(tm); },
    act(pid, a) { if (phase === 'q' && ids.has(pid) && !ans[pid] && a.c >= 0 && a.c < 4) {
      const ms = Number.isFinite(+a.ms) ? +a.ms : LIM; ans[pid] = { c: a.c | 0, ms: Math.max(0, Math.min(LIM, ms)) }; check(); } },
    leave() { if (phase === 'q') check(); },
    view(pid) {
      if (!ids.has(pid)) return { k: 'wait', msg: 'Trivia is in progress — you’ll be in the next game.' };
      const q = qs[i], rem = Math.max(0, end - now()), base = { title: 'Trivia Blitz', gid, n: i + 1, of: qs.length };
      if (phase === 'q') return { ...base, k: 'tq', q: q.q, cat: q.cat, opts: q.opts, ms: rem, lim: LIM, mine: ans[pid] ? ans[pid].c : null, done: Object.keys(ans).length, total: live().length };
      if (phase === 'rev') return { ...base, k: 'tr', q: q.q, opts: q.opts, ans: q.ans, mine: ans[pid] ? ans[pid].c : null, gain: gains[pid] || 0, pts: pts[pid], board: board(pts, ids), ms: rem, lim: 5000, last: i + 1 === qs.length };
      return { k: 'final', title: 'Trivia Blitz', board: board(pts, ids), unit: 'pts' };
    } };
}

function Imposter(o) {
  const cats = Object.keys(window.WORDS), cat = cats[Math.random() * cats.length | 0];
  const list = window.WORDS[cat], word = list[Math.random() * list.length | 0];
  const ids = H.players.map(p => p.id), idset = new Set(ids);
  const imps = new Set(shuffle(ids).slice(0, ids.length >= 7 ? 2 : 1));
  const order = shuffle(ids), hint = o.hint !== 'No';
  const choices = shuffle([word, ...shuffle(list.filter(w => w !== word)).slice(0, 7)]);
  let phase = 'reveal', caught = null, guess = null, impWon = false, tally = {}, gains = {};
  const ready = new Set(), votes = {};
  const live = () => H.players.filter(p => idset.has(p.id));
  const nm = id => (H.players.find(p => p.id === id) || {}).name || '(left)';
  function resolve() {
    tally = {}; for (const v of Object.values(votes)) tally[v] = (tally[v] || 0) + 1;
    const max = Math.max(0, ...Object.values(tally)), lead = Object.keys(tally).filter(k => tally[k] === max);
    if (lead.length === 1 && imps.has(lead[0]) && live().some(p => p.id === lead[0])) { caught = lead[0]; phase = 'guess'; }
    else { impWon = true; finish(); }
  }
  function finish() {
    phase = 'res'; gains = {};
    for (const p of live()) gains[p.id] = impWon ? (imps.has(p.id) ? 500 : 0) : (imps.has(p.id) ? 0 : 200);
    award(gains);
  }
  function settle() {
    if (phase === 'res') return;
    if (![...imps].some(id => live().some(p => p.id === id))) { impWon = false; finish(); return; }
    if (phase === 'reveal' && live().every(p => ready.has(p.id))) phase = 'talk';
    if (phase === 'vote' && live().every(p => votes[p.id])) resolve();
  }
  const card = pid => ({ imp: imps.has(pid), word: imps.has(pid) ? null : word, cat: imps.has(pid) && !hint ? null : cat, nImp: imps.size });
  return { start() { pushViews(); }, stop() {},
    act(pid, a) {
      if (!idset.has(pid)) return;
      if (phase === 'reveal' && a.a === 'ready') ready.add(pid);
      else if (phase === 'talk' && a.a === 'startvote' && pid === ME) phase = 'vote';
      else if (phase === 'vote' && a.a === 'pick' && !votes[pid] && idset.has(a.id) && a.id !== pid) votes[pid] = a.id;
      else if (phase === 'guess' && a.a === 'guess' && pid === caught) { guess = String(a.w); impWon = guess === word; finish(); }
      else return;
      settle(); pushViews();
    },
    leave(pid) { delete votes[pid]; for (const k in votes) if (votes[k] === pid) delete votes[k]; if (phase === 'guess' && pid === caught) { impWon = false; finish(); } settle(); },
    view(pid) {
      if (!idset.has(pid)) return { k: 'wait', msg: 'A round of Imposter is underway — you’ll be in the next one.' };
      const base = { title: 'Imposter' };
      if (phase === 'reveal') return { ...base, k: 'ir', ...card(pid), ready: ready.has(pid), done: ready.size, total: live().length };
      if (phase === 'talk') return { ...base, k: 'it', ...card(pid), order: order.filter(id => live().some(p => p.id === id)).map(nm) };
      if (phase === 'vote') return { ...base, k: 'iv', cands: live().filter(p => p.id !== pid).map(p => ({ id: p.id, name: p.name })), mine: votes[pid] || null, done: Object.keys(votes).length, total: live().length };
      if (phase === 'guess') return { ...base, k: 'ig', me: pid === caught, caught: nm(caught), cat, opts: pid === caught ? choices : null };
      return { ...base, k: 'ires', impWon, word, imps: [...imps].map(nm), youImp: imps.has(pid), caught: caught ? nm(caught) : null, guess,
        tally: Object.entries(tally).map(([id, c]) => ({ name: nm(id), c })).sort((a, b) => b.c - a.c), gain: gains[pid] || 0,
        board: H.players.map(p => ({ name: p.name, pts: p.score })).sort((a, b) => b.pts - a.pts) };
    } };
}

function Reaction(o) {
  const gid = rid(), RN = +o.r || 5, ids = new Set(H.players.map(p => p.id)), pts = {}; ids.forEach(id => pts[id] = 0);
  let r = -1, phase = '', res = {}, delay = 0, t0 = 0, tm = null, gains = {}, end = 0;
  const live = () => H.players.filter(p => ids.has(p.id));
  function next() { clearTimeout(tm); r++;
    if (r >= RN) { phase = 'final'; award(pts); pushViews(); return; }
    phase = 'go'; res = {}; delay = 1500 + Math.random() * 3500 | 0; t0 = now(); tm = setTimeout(close, delay + 3000); pushViews(); }
  function close() { if (phase !== 'go') return; clearTimeout(tm); phase = 'rr'; gains = {};
    const ok = live().filter(p => res[p.id] && res[p.id].ms != null).sort((a, b) => res[a.id].ms - res[b.id].ms), n = live().length;
    ok.forEach((p, k) => { gains[p.id] = (n - k) * 100; });
    for (const p of live()) pts[p.id] += gains[p.id] || 0;
    end = now() + 4000; tm = setTimeout(next, 4000); pushViews(); }
  const check = () => { if (live().every(p => res[p.id])) close(); else pushViews(); };
  return { start: next, stop() { clearTimeout(tm); },
    act(pid, a) { if (phase !== 'go' || !ids.has(pid) || res[pid]) return;
      if (a.early) res[pid] = { early: true };
      else { const ms = +a.ms; if (!(ms >= 0 && ms < 10000)) return; res[pid] = { ms: Math.round(ms) }; }
      check(); },
    leave() { if (phase === 'go') check(); },
    view(pid) {
      if (!ids.has(pid)) return { k: 'wait', msg: 'Quick Draw is in progress — you’ll be in the next game.' };
      const base = { title: 'Quick Draw', gid, r: r + 1, of: RN };
      if (phase === 'go') return { ...base, k: 'rx', delay: Math.max(0, delay - (now() - t0)), done: Object.keys(res).length, total: live().length };
      if (phase === 'rr') return { ...base, k: 'rr', ms: Math.max(0, end - now()), lim: 4000, last: r + 1 === RN,
        rows: live().map(p => ({ id: p.id, name: p.name, ms: res[p.id] && res[p.id].ms, early: !!(res[p.id] && res[p.id].early), gain: gains[p.id] || 0 }))
          .sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9)) };
      return { k: 'final', title: 'Quick Draw', board: board(pts, ids), unit: 'pts' };
    } };
}

/* ---------- rendering (every phone, host included) ---------- */
const SHAPES = ['<svg viewBox="0 0 20 20"><path d="M10 2 19 18H1z"/></svg>', '<svg viewBox="0 0 20 20"><path d="M10 1 19 10 10 19 1 10z"/></svg>',
  '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9"/></svg>', '<svg viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="2"/></svg>'];
const top = (title, prog) => `<header class="top"><b>${esc(title)}</b><span>${esc(prog || '')}</span>${Net.host ? '<button class="x" data-host="lobby">End game</button>' : ''}</header>`;
const timer = v => `<div class="timer"><i data-end="${now() + v.ms}" data-lim="${v.lim}"></i><b class="secs"></b></div>`;
const actAttr = o => `data-act="${esc(JSON.stringify(o))}"`;
const rows = (list, unit) => `<ol class="board">${list.map((p, k) => `<li class="${p.id === YOU ? 'me' : ''}"><span class="rk">${k + 1}</span><span class="nm">${esc(p.name)}</span><b>${p.pts}</b></li>`).join('')}</ol>`;
const hostEnd = () => Net.host ? `<div class="row2"><button class="big b3" data-host="again">Play again</button><button class="big b1" data-host="lobby">Back to lobby</button></div>` : `<p class="muted center">Waiting for the host…</p>`;
let TQ = { key: '' }, RX = { key: '' };

const R = {
  lobby(v) {
    const players = `<ul class="chips">${v.players.map(p => `<li class="${p.id === YOU ? 'me' : ''}">${esc(p.name)}${p.id === 'h' ? ' <small>host</small>' : ''}${p.score ? ` <small>${p.score}</small>` : ''}</li>`).join('')}</ul>`;
    if (!Net.host) { app.innerHTML = `<section class="pane">${TILES}<h2>You’re in!</h2><p class="muted">Waiting for the host to pick a game. Keep your screen on.</p><h3>Players (${v.players.length})</h3>${players}</section>`; return; }
    const games = Object.entries(GAMES).map(([key, g]) => {
      const o = H.opts[key] || {}, enough = v.players.length >= g.min;
      return `<article class="game g-${key}"><h3>${g.name}</h3><p>${g.desc}</p>
        <div class="opts">${g.opts.map(([k, label, vals]) => `<label><span>${label}</span><select data-opt="${key}.${k}">${vals.map(x => `<option ${o[k] === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`).join('')}</div>
        <button class="big b${key === 'trivia' ? 0 : key === 'imposter' ? 1 : 2}" data-host="start:${key}" ${enough ? '' : 'disabled'}>${enough ? 'Start' : 'Needs ' + g.min + '+ players'}</button></article>`;
    }).join('');
    app.innerHTML = `<section class="pane"><header class="lobbyhead"><h2>Lobby</h2><button class="ghost sm" data-host="end">End session</button></header>
      <h3>Players (${v.players.length})</h3>${players}
      <button class="big b3" data-host="add">+ Add player</button>
      <h3>Pick a game</h3><div class="games">${games}</div></section>`;
  },
  wait(v) { app.innerHTML = `<section class="pane center"><div class="spin"></div><p class="lead">${esc(v.msg)}</p></section>`; },
  tq(v) {
    const key = v.gid + v.n; if (TQ.key !== key) TQ = { key, shown: now(), base: v.lim - v.ms };
    const locked = v.mine != null;
    app.innerHTML = top(v.title, `Question ${v.n} of ${v.of}`) + timer(v) +
      `<section class="pane q"><p class="cat">${esc(v.cat)}</p><h2 class="qt">${esc(v.q)}</h2>
      <div class="answers">${v.opts.map((t, i) => `<button class="ans a${i}${v.mine === i ? ' picked' : ''}${locked && v.mine !== i ? ' dim' : ''}" data-ans="${i}" ${locked ? 'disabled' : ''}>${SHAPES[i]}<span>${esc(t)}</span></button>`).join('')}</div>
      <p class="muted center">${locked ? 'Locked in. ' : ''}${v.done} of ${v.total} answered</p></section>`;
  },
  tr(v) {
    const right = v.mine === v.ans, me = v.board.findIndex(p => p.id === YOU) + 1;
    app.innerHTML = top(v.title, `Question ${v.n} of ${v.of}`) + timer(v) +
      `<section class="pane"><div class="verdict ${right ? 'ok' : 'no'}"><b>${right ? '+' + v.gain : v.mine == null ? 'Too slow' : 'Wrong'}</b><span>${v.pts} pts · ${ordinal(me)} place</span></div>
      <h2 class="qt sm">${esc(v.q)}</h2>
      <div class="answers rev">${v.opts.map((t, i) => `<div class="ans a${i}${i === v.ans ? ' right' : ' dim'}">${SHAPES[i]}<span>${esc(t)}</span>${i === v.mine ? '<em>you</em>' : ''}</div>`).join('')}</div>
      <h3>${v.last ? 'Final scores coming up' : 'Leaderboard'}</h3>${rows(v.board.slice(0, 5))}</section>`;
  },
  final(v) {
    const b = v.board, pod = [b[1], b[0], b[2]];
    app.innerHTML = `<section class="pane"><h2 class="center">${esc(v.title)} — results</h2>
      <div class="podium">${pod.map((p, k) => p ? `<div class="pl p${[2, 1, 3][k]}"><span class="nm">${esc(p.name)}</span><b>${p.pts}</b><i>${[2, 1, 3][k]}</i></div>` : '<div></div>').join('')}</div>
      ${rows(b)}${hostEnd()}</section>`;
  },
  ir(v) {
    app.innerHTML = top(v.title, 'Look at your card') + `<section class="pane">${secret(v)}
      <p class="muted">${v.imp ? 'Blend in. Listen to the clues and fake it.' : `Find the imposter${v.nImp > 1 ? 's' : ''}. Don’t make your clue too obvious.`}</p>
      ${v.ready ? `<p class="wait"><span class="spin sm"></span>Waiting: ${v.done} of ${v.total} ready</p>` : `<button class="big b3" ${actAttr({ a: 'ready' })}>I’ve seen it — ready</button>`}</section>`;
  },
  it(v) {
    app.innerHTML = top(v.title, 'Clue time') + `<section class="pane"><h2>Say one-word clues out loud</h2>
      <p class="muted">Go around in this order, twice. Then the host starts the vote.</p>
      <ol class="order">${v.order.map(n => `<li>${esc(n)}</li>`).join('')}</ol>${secret(v)}
      ${Net.host ? `<button class="big b0" ${actAttr({ a: 'startvote' })}>Start the vote</button>` : ''}</section>`;
  },
  iv(v) {
    app.innerHTML = top(v.title, 'Vote') + `<section class="pane"><h2>Who’s the imposter?</h2>
      <div class="votes">${v.cands.map(c => `<button class="vote${v.mine === c.id ? ' picked' : ''}" ${v.mine ? 'disabled' : actAttr({ a: 'pick', id: c.id })}>${esc(c.name)}</button>`).join('')}</div>
      <p class="muted center">${v.mine ? 'Vote locked. ' : ''}${v.done} of ${v.total} voted</p></section>`;
  },
  ig(v) {
    app.innerHTML = top(v.title, 'Last chance') + (v.me
      ? `<section class="pane"><h2>You were caught!</h2><p class="muted">Guess the secret word to steal the win. Category: ${esc(v.cat)}</p>
         <div class="votes">${v.opts.map(w => `<button class="vote" ${actAttr({ a: 'guess', w })}>${esc(w)}</button>`).join('')}</div></section>`
      : `<section class="pane center"><h2>${esc(v.caught)} was caught!</h2><div class="spin"></div><p class="muted">They get one guess at the secret word…</p></section>`);
  },
  ires(v) {
    const youWon = v.youImp === v.impWon;
    app.innerHTML = top(v.title, 'Results') + `<section class="pane"><div class="verdict ${youWon ? 'ok' : 'no'}"><b>${v.impWon ? 'Imposter wins' : 'Crew wins'}</b><span>${v.gain ? '+' + v.gain + ' for you' : 'No points for you'}</span></div>
      <p class="lead">The word was <b>${esc(v.word)}</b>. ${v.imps.length > 1 ? 'Imposters' : 'Imposter'}: <b>${esc(v.imps.join(' & '))}</b>.
      ${v.caught ? (v.guess != null ? `${esc(v.caught)} guessed “${esc(v.guess)}”.` : '') : 'Nobody was caught.'}</p>
      ${v.tally.length ? `<h3>Votes</h3><ul class="tally">${v.tally.map(t => `<li><span>${esc(t.name)}</span><b>${t.c}</b></li>`).join('')}</ul>` : ''}
      <h3>Session totals</h3>${rows(v.board)}${hostEnd()}</section>`;
  },
  rx(v) {
    const key = v.gid + v.r;
    if (RX.key !== key) { clearTimeout(RX.tm); RX = { key, st: 'wait', at: 0, ms: null }; RX.tm = setTimeout(() => { RX.st = 'go'; padUpdate(); requestAnimationFrame(t => { RX.at = t; }); }, v.delay); }
    RX.done = v.done; RX.total = v.total;
    app.innerHTML = top(v.title, `Round ${v.r} of ${v.of}`) + `<section class="pane"><div id="pad" class="pad"></div><p class="muted center" id="rxs"></p></section>`;
    padUpdate();
  },
  rr(v) {
    app.innerHTML = top(v.title, `Round ${v.r} of ${v.of}`) + timer(v) + `<section class="pane"><h2>${v.last ? 'Last round!' : 'Round results'}</h2>
      <ol class="board">${v.rows.map((p, k) => `<li class="${p.id === YOU ? 'me' : ''}"><span class="rk">${p.ms != null ? k + 1 : '–'}</span><span class="nm">${esc(p.name)}</span><span class="ms">${p.ms != null ? p.ms + ' ms' : p.early ? 'jumped early' : 'no tap'}</span><b>${p.gain ? '+' + p.gain : ''}</b></li>`).join('')}</ol></section>`;
  },
  unknown() { app.innerHTML = `<section class="pane center"><p class="muted">This phone needs a newer version — reload the page.</p></section>`; }
};
function secret(v) {
  const face = v.imp ? `<b>You’re the imposter</b><span>${v.cat ? 'Category: ' + esc(v.cat) : 'No hints. Good luck.'}</span>`
    : `<span>${esc(v.cat)}</span><b>${esc(v.word)}</b>`;
  return `<div class="secret${v.imp ? ' imp' : ''}" tabindex="0"><div class="cover">Press and hold to see your word</div><div class="face">${face}</div></div>`;
}
function padUpdate() {
  const pad = $('#pad'); if (!pad) return;
  const t = { wait: ['Wait for green…', 'wait'], go: ['TAP!', 'go'], early: ['Too soon!', 'early'], done: [RX.ms + ' ms', 'done'] }[RX.st];
  pad.className = 'pad ' + t[1]; pad.textContent = t[0];
  const s = $('#rxs'); if (s) s.textContent = `${RX.done} of ${RX.total} done`;
}
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
function render() { const v = VIEW; if (!v) return; (R[v.k] || R.unknown)(v); }

/* ---------- input ---------- */
app.addEventListener('click', e => {
  const t = e.target.closest('button, [data-copy]'); if (!t || t.disabled) return;
  if (t.dataset.ans != null && VIEW && VIEW.k === 'tq' && VIEW.mine == null) {
    const c = +t.dataset.ans; act({ c, ms: TQ.base + (now() - TQ.shown) }); VIEW.mine = c; VIEW.done++; render(); return;
  }
  if (t.dataset.act) { try { act(JSON.parse(t.dataset.act)); } catch (x) {} return; }
  const h = t.dataset.host; if (!h || !Net.host) return;
  if (h === 'add') addFlow();
  else if (h === 'lobby') toLobby();
  else if (h === 'again') startGame(H.key);
  else if (h.startsWith('start:')) startGame(h.slice(6));
  else if (h === 'end') { if (confirm('End the session for everyone?')) { for (const p of H.players) { try { p.pc && p.pc.close(); } catch (x) {} } H.players = []; home(); } }
});
app.addEventListener('change', e => {
  const s = e.target.closest('select[data-opt]'); if (!s) return;
  const [g, k] = s.dataset.opt.split('.'); (H.opts[g] = H.opts[g] || {})[k] = s.value;
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const ta = b.parentNode.querySelector('textarea'); ta.select();
  (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).then(() => toast('Copied'), () => { try { document.execCommand('copy'); toast('Copied'); } catch (x) {} });
});
app.addEventListener('pointerdown', e => {
  const pad = e.target.closest('#pad');
  if (pad) {
    e.preventDefault();
    if (RX.st === 'wait') { clearTimeout(RX.tm); RX.st = 'early'; act({ early: true }); RX.done++; }
    else if (RX.st === 'go') { const ms = Math.max(0, Math.round(e.timeStamp - RX.at)); if (ms < 90) { RX.st = 'early'; act({ early: true }); } else { RX.st = 'done'; RX.ms = ms; act({ ms }); } RX.done++; }
    padUpdate(); return;
  }
  const sec = e.target.closest('.secret');
  if (sec) { sec.classList.add('show'); const off = () => { sec.classList.remove('show'); window.removeEventListener('pointerup', off); window.removeEventListener('pointercancel', off); };
    window.addEventListener('pointerup', off); window.addEventListener('pointercancel', off); }
});
app.addEventListener('contextmenu', e => { if (e.target.closest('.secret, #pad')) e.preventDefault(); });

(function tick() {
  for (const i of document.querySelectorAll('.timer i[data-end]')) {
    const rem = Math.max(0, +i.dataset.end - now()); i.style.width = (rem / +i.dataset.lim * 100) + '%';
    const s = i.parentNode.querySelector('.secs'); if (s) s.textContent = Math.ceil(rem / 1000);
  }
  requestAnimationFrame(tick);
})();
window.addEventListener('beforeunload', e => { if (Net.host && H.players.length > 1) { e.preventDefault(); e.returnValue = ''; } });

if (!window.RTCPeerConnection) app.innerHTML = `<section class="pane center"><h2>This browser can’t do it</h2><p class="muted">Open this page in Safari (iPhone) or Chrome (Android).</p></section>`;
else home();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__tp = { H, Net, pack, unpack };
}
