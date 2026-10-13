'use strict';

// Analyse sur une image réduite (largeur réglable) : peu coûteux, même sur un petit téléphone.
const FRAME_MS = 80;    // ~12 images/s analysées
const CONFIRM = 2;      // images consécutives au-dessus du seuil pour déclencher

const $ = (id) => document.getElementById(id);
const video = $('video'), view = $('view'), overlay = $('overlay'), zoneEl = $('zone');
const banner = $('banner'), hint = $('hint'), meterFill = $('meterFill');
const levelEl = $('level'), thrEl = $('thr');
const goBtn = $('go'), camBtn = $('cam'), flipBtn = $('flip'), zoneBtn = $('zoneBtn');

// ---------- Réglages persistants ----------
const DEFAULTS = { sens2: 50, res: 160, delay: 5, cool: 2, sound: 'alarm', deviceId: null, zone: null, count: 0, best: 0 };
let cfg = { ...DEFAULTS };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('statue') || '{}')); } catch (e) {}
function save() { try { localStorage.setItem('statue', JSON.stringify(cfg)); } catch (e) {} }

// ---------- Son (Web Audio, aucun fichier) ----------
let ac = null;
function audio() {
  if (!ac) { const C = window.AudioContext || window.webkitAudioContext; if (C) ac = new C(); }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(f0, dur, { type = 'sine', vol = 0.5, f1 = 0, at = 0 } = {}) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
const SOUNDS = {
  alarm() { for (let i = 0; i < 3; i++) tone(1400, 0.16, { type: 'square', vol: 0.45, f1: 700, at: i * 0.18 }); },
  buzz() { tone(110, 0.6, { type: 'sawtooth', vol: 0.6 }); tone(116, 0.6, { type: 'square', vol: 0.3 }); },
  beep() { tone(1000, 0.25, { type: 'sine', vol: 0.7 }); },
  off() {},
};
const playHit = () => (SOUNDS[cfg.sound] || SOUNDS.alarm)();

// ---------- Maintien de l'écran allumé ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}

// ---------- Caméra ----------
let stream = null;
async function startCamera() {
  stopCamera();
  hint.textContent = 'Ouverture de la caméra…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(cfg.deviceId ? { deviceId: { exact: cfg.deviceId } } : { facingMode: 'user' }),
        width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 },
      },
    });
  } catch (e) {
    if (cfg.deviceId) { cfg.deviceId = null; save(); return startCamera(); } // caméra disparue

    hint.textContent = "Caméra inaccessible : autorise-la dans le navigateur (" + e.name + ").";
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  // Effet miroir pour une caméra frontale ou une webcam, pas pour la caméra arrière.
  const settings = stream.getVideoTracks()[0].getSettings();
  view.classList.toggle('mirror', settings.facingMode !== 'environment');
  [goBtn, flipBtn, zoneBtn].forEach((b) => (b.disabled = false));
  camBtn.textContent = 'Caméra ✓';
  hint.textContent = state === 'idle' ? 'Prêt. Règle la zone si besoin, puis « Démarrer ».' : '';
  setupAnalysis();
  if (!timer) timer = setInterval(loop, FRAME_MS);
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------- Analyse du mouvement ----------
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const octx = overlay.getContext('2d');
let AW = 160, AH = 120, N = 0, cur, tmp, bg, mask, maskN = 0, ovImg, bgReady = false;
let timer = 0, hits = 0;

function setupAnalysis() {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const ar = vw / vh;
  AW = cfg.res;
  view.style.aspectRatio = vw + ' / ' + vh;
  view.style.width = 'min(100%, calc(58vh * ' + ar.toFixed(4) + '))';
  AH = Math.max(1, Math.round(AW / ar));
  N = AW * AH;
  work.width = overlay.width = AW;
  work.height = overlay.height = AH;
  cur = new Float32Array(N);
  tmp = new Float32Array(N);
  bg = new Float32Array(N);
  mask = new Uint8Array(N);
  ovImg = octx.createImageData(AW, AH);
  buildMask();
  bgReady = false;
}

function buildMask() {
  if (!mask) return;
  const z = cfg.zone || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const x0 = Math.floor(z.x0 * AW), x1 = Math.ceil(z.x1 * AW);
  const y0 = Math.floor(z.y0 * AH), y1 = Math.ceil(z.y1 * AH);
  maskN = 0;
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const m = x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0;
    mask[y * AW + x] = m; maskN += m;
  }
  drawZone();
}

// Sensibilité 0..100 -> écart de luminosité par pixel (40 à 12) et part de la zone qui doit
// changer (15 % à 0,03 %, échelle logarithmique : chaque cran change le seuil du même facteur).
function thresholds() {
  const v = cfg.sens2 / 100;
  return { pix: 40 - 28 * v, area: 0.15 * Math.pow(0.002, v) };
}

// Flou 3x3 : moyenne le bruit du capteur, surtout utile aux résolutions fines.
function blur() {
  for (let y = 0; y < AH; y++) {
    const r = y * AW;
    for (let x = 0; x < AW; x++) {
      const i = r + x;
      tmp[i] = cur[x > 0 ? i - 1 : i] + cur[i] + cur[x < AW - 1 ? i + 1 : i];
    }
  }
  for (let y = 0; y < AH; y++) {
    const u = (y > 0 ? y - 1 : y) * AW, r = y * AW, d = (y < AH - 1 ? y + 1 : y) * AW;
    for (let x = 0; x < AW; x++) cur[r + x] = (tmp[u + x] + tmp[r + x] + tmp[d + x]) / 9;
  }
}
const pct = (f) => (f * 100).toFixed(f < 0.01 ? 2 : 1);

function loop() {
  if (!stream || video.readyState < 2) return;
  analyse(performance.now());
}

function analyse(now) {
  wctx.drawImage(video, 0, 0, AW, AH);
  const d = wctx.getImageData(0, 0, AW, AH).data;
  for (let i = 0, j = 0; i < N; i++, j += 4) cur[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  blur();
  let sc = 0, sb = 0;
  for (let i = 0; i < N; i++) if (mask[i]) { sc += cur[i]; sb += bg[i]; }
  if (!bgReady) { bg.set(cur); bgReady = true; return; }

  // Compense les variations globales de luminosité (exposition automatique).
  const off = maskN ? (sc - sb) / maskN : 0;
  const { pix, area } = thresholds();
  const px = ovImg.data;
  let changed = 0;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    let hit = 0;
    if (mask[i]) {
      const diff = cur[i] - bg[i] - off;
      if (diff > pix || diff < -pix) { hit = 1; changed++; }
    }
    px[j] = 255; px[j + 1] = 60; px[j + 2] = 60; px[j + 3] = hit ? 150 : 0;
  }
  octx.putImageData(ovImg, 0, 0);

  const score = maskN ? changed / maskN : 0;
  const ratio = score / area;
  meterFill.style.width = Math.min(100, ratio * 50) + '%';
  meterFill.classList.toggle('over', ratio >= 1);
  levelEl.textContent = pct(score);

  // Fond de référence : s'adapte lentement quand on surveille, vite sinon.
  let a = 0.25;
  if (state === 'armed') a = now < coolUntil ? 0.3 : 0.03;
  for (let i = 0; i < N; i++) bg[i] += a * (cur[i] - bg[i]);

  if (state === 'armed' && now >= coolUntil) {
    hits = ratio >= 1 ? hits + 1 : 0;
    if (hits >= CONFIRM) { hits = 0; detected(now); }
  }
}

// ---------- États : idle -> countdown -> armed ----------
let state = 'idle', countTimer = 0, coolUntil = 0, streakStart = 0, clockTimer = 0;

function setState(s) {
  state = s;
  document.body.classList.toggle('armed', s === 'armed');
  goBtn.classList.toggle('stop', s !== 'idle');
  goBtn.textContent = s === 'idle' ? 'Démarrer' : s === 'countdown' ? 'Annuler' : 'Arrêter';
  camBtn.disabled = s !== 'idle';
  flipBtn.disabled = zoneBtn.disabled = s !== 'idle' || !stream;
  if (s !== 'idle') stopPicking();
}

function start() {
  audio();
  keepAwake(true);
  let n = Math.round(cfg.delay);
  setState('countdown');
  hint.textContent = 'Mets-toi en place…';
  const step = () => {
    if (n <= 0) { banner.hidden = true; arm(); return; }
    banner.hidden = false; banner.textContent = n; n--;
    countTimer = setTimeout(step, 1000);
  };
  step();
}

function arm() {
  bgReady = false; hits = 0;
  coolUntil = performance.now() + 600; // laisse le fond se stabiliser
  streakStart = Date.now();
  setState('armed');
  hint.textContent = 'Surveillance en cours. Ne bouge plus.';
  clockTimer = setInterval(updateClock, 250);
}

function stop() {
  clearTimeout(countTimer); clearInterval(clockTimer);
  banner.hidden = true;
  if (state === 'armed') bumpBest();
  setState('idle');
  keepAwake(false);
  hint.textContent = 'Arrêté.';
  updateClock();
}

function detected(now) {
  playHit();
  bumpBest();
  cfg.count++; save();
  $('count').textContent = cfg.count;
  coolUntil = now + cfg.cool * 1000;
  streakStart = Date.now() + cfg.cool * 1000;
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), Math.min(1200, cfg.cool * 1000));
}

function bumpBest() {
  const s = Math.max(0, Math.floor((Date.now() - streakStart) / 1000));
  if (s > cfg.best) { cfg.best = s; save(); }
}

const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
function updateClock() {
  const s = state === 'armed' ? Math.max(0, Math.floor((Date.now() - streakStart) / 1000)) : 0;
  $('streak').textContent = fmt(s);
  $('best').textContent = fmt(Math.max(cfg.best, s));
}

// ---------- Zone surveillée ----------
let picking = false, drag = null;
function stopPicking() { picking = false; view.classList.remove('picking'); zoneBtn.classList.remove('on'); }

function drawZone() {
  const z = cfg.zone;
  if (!z) { zoneEl.hidden = true; return; }
  const mirror = view.classList.contains('mirror');
  const left = mirror ? 1 - z.x1 : z.x0;
  Object.assign(zoneEl.style, {
    left: left * 100 + '%', top: z.y0 * 100 + '%',
    width: (z.x1 - z.x0) * 100 + '%', height: (z.y1 - z.y0) * 100 + '%',
  });
  zoneEl.hidden = false;
}

function pointerPos(e) {
  const r = view.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (view.classList.contains('mirror')) x = 1 - x;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
view.addEventListener('pointerdown', (e) => {
  if (!picking) return;
  view.setPointerCapture(e.pointerId);
  drag = pointerPos(e);
});
view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pointerPos(e);
  cfg.zone = { x0: Math.min(drag.x, p.x), y0: Math.min(drag.y, p.y), x1: Math.max(drag.x, p.x), y1: Math.max(drag.y, p.y) };
  drawZone();
});
view.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  const z = cfg.zone;
  if (!z || z.x1 - z.x0 < 0.05 || z.y1 - z.y0 < 0.05) cfg.zone = null; // trop petit : image entière
  save(); buildMask(); stopPicking();
  hint.textContent = cfg.zone ? 'Zone enregistrée.' : 'Zone : image entière.';
});

// ---------- Boutons et réglages ----------
camBtn.onclick = () => { audio(); startCamera(); };
flipBtn.onclick = async () => {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (cams.length < 2) { hint.textContent = 'Une seule caméra disponible.'; return; }
  const curId = stream && stream.getVideoTracks()[0].getSettings().deviceId;
  const k = cams.findIndex((c) => c.deviceId === curId);
  cfg.deviceId = cams[(k + 1) % cams.length].deviceId; save();
  await startCamera();
  const label = cams[(k + 1) % cams.length].label;
  if (label && state === 'idle') hint.textContent = 'Caméra : ' + label;
};
goBtn.onclick = () => (state === 'idle' ? start() : stop());
zoneBtn.onclick = () => {
  if (picking) { stopPicking(); return; }
  if (cfg.zone) { cfg.zone = null; save(); buildMask(); hint.textContent = 'Zone : image entière. Rappuie pour en tracer une.'; return; }
  picking = true; view.classList.add('picking'); zoneBtn.classList.add('on');
  hint.textContent = "Trace un rectangle sur l'image avec le doigt.";
};
$('reset').onclick = () => {
  if (!confirm('Remettre le compteur et le record à zéro ?')) return;
  cfg.count = 0; cfg.best = 0; save();
  $('count').textContent = 0;
  if (state === 'armed') streakStart = Date.now();
  updateClock();
};
$('test').onclick = () => playHit();

function bindRange(id, key, fmtOut) {
  const el = $(id), out = $(id + 'Out');
  el.value = cfg[key];
  const show = () => { out.textContent = fmtOut(+el.value); };
  el.oninput = () => { cfg[key] = +el.value; show(); save(); };
  show();
  return el;
}
const sensEl = bindRange('sens', 'sens2', (v) => { thrEl.textContent = pct(thresholds().area); return v.toFixed(1); });
function nudge(dv) {
  sensEl.value = Math.min(100, Math.max(0, +sensEl.value + dv));
  sensEl.oninput();
}
$('sensMinus').onclick = () => nudge(-0.5);
$('sensPlus').onclick = () => nudge(0.5);
$('res').value = cfg.res;
$('res').onchange = (e) => { cfg.res = +e.target.value; save(); if (stream) setupAnalysis(); };
bindRange('delay', 'delay', (v) => v + ' s');
bindRange('cool', 'cool', (v) => v + ' s');
$('sound').value = cfg.sound;
$('sound').onchange = (e) => { cfg.sound = e.target.value; save(); playHit(); };
$('count').textContent = cfg.count;
updateClock();

// Retour au premier plan : la caméra a pu être coupée, et l'image a pu changer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  bgReady = false; hits = 0;
  if (state === 'armed') coolUntil = performance.now() + 800;
  if (state !== 'idle') keepAwake(true);
  if (stream && stream.getVideoTracks().some((t) => t.readyState === 'ended')) startCamera();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
