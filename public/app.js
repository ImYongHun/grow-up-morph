import { alignFace, downscale, loadImage, triangulate, lerpPts, warmup } from './face.js';
import { MorphRenderer } from './morph.js';

const AGES = [0, 5, 10, 15, 20];
const ROLE_LABEL = { baby: '아기 사진', mom: '엄마 사진', dad: '아빠 사진' };

// 로컬 모핑: 나이별로 얼굴형을 부모 쪽으로 얼마나 옮길지 / 아기 피부·이목구비를 얼마나 남길지
const LOCAL_SHAPE = { 5: 0.35, 10: 0.6, 15: 0.85, 20: 1.0 };
const LOCAL_BABY_TEX = { 5: 0.7, 10: 0.52, 15: 0.38, 20: 0.28 };

const $ = (s) => document.querySelector(s);
const state = {
  photos: {}, // role → { dataUrl, face: {canvas, pts} }
  sex: 'boy',
  provider: 'local',
  config: { openai: false, gemini: false },
  keyframes: [], // [{ age, canvas, pts }]
  years: 0,
};

let player; // MorphRenderer for the stage
let anim = null;

/* ---------- 초기화 ---------- */

init();

async function init() {
  warmup().catch(() => {});
  setupUploads();
  setupSeg('#sex', (v) => (state.sex = v));
  setupSeg('#provider', (v) => { state.provider = v; updateProviderHint(); updateGenerateButton(); });

  const ratio = $('#dadRatio');
  const showRatio = () => {
    const d = Number(ratio.value);
    $('#dadRatioOut').textContent = d === 50 ? '반반' : d > 50 ? `아빠 ${d}%` : `엄마 ${100 - d}%`;
  };
  ratio.addEventListener('input', showRatio);
  showRatio();

  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {
    // 서버 없이 파일로 열었을 때: 로컬 모드만
  }
  updateProviderHint();

  $('#generate').addEventListener('click', generate);
  $('#restart').addEventListener('click', () => {
    $('#viewer').hidden = true;
    $('#setup').scrollIntoView({ behavior: 'smooth' });
  });
  setupViewer();
}

function setupSeg(sel, onChange) {
  const seg = $(sel);
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
}

function updateProviderHint() {
  const p = state.provider;
  const c = state.config;
  const hint = $('#providerHint');
  if (p === 'local') {
    hint.innerHTML = '부모 얼굴형과 피부톤을 수학적으로 섞어서 만들어요. API 키 없이 바로 되지만, 사실감은 AI 방식보다 떨어져요.';
  } else {
    const ok = c[p];
    const name = p === 'openai' ? 'OpenAI' : 'Gemini';
    const model = p === 'openai' ? c.openaiModel : c.geminiModel;
    const key = p === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
    hint.innerHTML = ok
      ? `${name} (${model})로 5·10·15·20년 후 사진 4장을 차례로 만들어요. 장당 20초~1분 정도 걸리고 API 사용료가 들어요.`
      : `⚠️ <code>.env</code> 파일에 <code>${key}</code>를 넣고 서버를 다시 실행하면 쓸 수 있어요. (README 참고)`;
  }
}

function updateGenerateButton() {
  const ready = ['baby', 'mom', 'dad'].every((r) => state.photos[r]?.face);
  const providerOk = state.provider === 'local' || state.config[state.provider];
  $('#generate').disabled = !(ready && providerOk);
}

/* ---------- 사진 업로드 ---------- */

function setupUploads() {
  document.querySelectorAll('.drop').forEach((drop) => {
    const role = drop.dataset.role;
    const input = drop.querySelector('input');
    input.addEventListener('change', () => input.files[0] && handleFile(role, drop, input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) handleFile(role, drop, f);
    });
  });
}

async function handleFile(role, drop, file) {
  const thumb = drop.querySelector('.thumb');
  const small = drop.querySelector('small');
  drop.classList.remove('ok', 'err');
  small.textContent = '얼굴 찾는 중…';
  delete state.photos[role];
  updateGenerateButton();
  try {
    const raw = await loadImage(await readAsDataUrl(file));
    const dataUrl = downscale(raw, 1024);
    const img = await loadImage(dataUrl);
    thumb.innerHTML = '';
    thumb.appendChild(img);
    const face = await alignFace(img, ROLE_LABEL[role]);
    state.photos[role] = { dataUrl, face };
    drop.classList.add('ok');
    small.textContent = '✓ 얼굴 인식 완료';
  } catch (e) {
    drop.classList.add('err');
    small.textContent = e.message.includes('얼굴') ? '얼굴을 못 찾았어요 😢 다른 사진으로' : e.message;
    console.error(e);
  }
  updateGenerateButton();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('파일을 읽을 수 없습니다'));
    r.readAsDataURL(file);
  });
}

/* ---------- 생성 ---------- */

function dadRatio() {
  return Number($('#dadRatio').value) / 100;
}

function babyYears() {
  return Math.max(0, Number($('#babyMonths').value) || 0) / 12;
}

function progress(rows) {
  const el = $('#progress');
  el.hidden = false;
  el.innerHTML = rows
    .map((r) => `<div class="row ${r.status}">${r.status === 'active' ? '<span class="spin"></span>' : r.status === 'done' ? '✓' : r.status === 'fail' ? '✕' : '·'} ${r.text}</div>`)
    .join('');
}

async function generate() {
  const btn = $('#generate');
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  try {
    const keyframes = state.provider === 'local' ? await generateLocal() : await generateAI(state.provider);
    if (keyframes.length < 2) throw new Error('만들어진 사진이 부족해요');
    showViewer(keyframes);
  } catch (e) {
    console.error(e);
    alert(e.message);
  } finally {
    btn.textContent = '성장 모습 만들기';
    updateGenerateButton();
  }
}

async function generateLocal() {
  const { baby, mom, dad } = state.photos;
  const B = baby.face, M = mom.face, D = dad.face;
  // 성별에 따라 같은 성의 부모 쪽으로 살짝 더 기울임
  const mix = Math.min(1, Math.max(0, dadRatio() + (state.sex === 'boy' ? 0.08 : -0.08)));
  const parentShape = lerpPts(M.pts, D.pts, mix);

  const off = new MorphRenderer(document.createElement('canvas'));
  off.setTriangles(triangulate([B.pts, M.pts, D.pts]));

  const rows = AGES.slice(1).map((y) => ({ text: `${y}년 후 합성`, status: '' }));
  const keyframes = [{ age: 0, canvas: B.canvas, pts: B.pts }];
  for (const [i, y] of AGES.slice(1).entries()) {
    rows[i].status = 'active';
    progress(rows);
    await nextFrame();
    const dst = lerpPts(B.pts, parentShape, LOCAL_SHAPE[y]);
    const tb = LOCAL_BABY_TEX[y];
    off.render(
      [
        { ...B, weight: tb },
        { ...M, weight: (1 - tb) * (1 - mix) },
        { ...D, weight: (1 - tb) * mix },
      ],
      dst,
    );
    keyframes.push({ age: y, canvas: off.snapshot(), pts: dst });
    rows[i].status = 'done';
  }
  off.dispose();
  progress(rows);
  return keyframes;
}

async function generateAI(provider) {
  const { baby, mom, dad } = state.photos;
  const rows = AGES.slice(1).map((y) => ({ text: `${y}년 후 (약 ${Math.round(babyYears() + y)}세) 생성`, status: '' }));
  const keyframes = [{ age: 0, canvas: baby.face.canvas, pts: baby.face.pts }];
  let prev = null;

  for (const [i, y] of AGES.slice(1).entries()) {
    rows[i].status = 'active';
    progress(rows);
    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baby: baby.dataUrl,
          mom: mom.dataUrl,
          dad: dad.dataUrl,
          prev: prev?.dataUrl,
          prevAge: prev ? Math.round(babyYears() + prev.age) : undefined,
          years: y,
          targetAge: Math.round(babyYears() + y),
          sex: state.sex,
          dadRatio: dadRatio(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `서버 오류 ${r.status}`);
      const img = await loadImage(j.image);
      const face = await alignFace(img, `${y}년 후 사진`);
      keyframes.push({ age: y, canvas: face.canvas, pts: face.pts });
      prev = { age: y, dataUrl: downscale(img, 1024) };
      rows[i].status = 'done';
    } catch (e) {
      rows[i].status = 'fail';
      rows[i].text += ` — ${e.message}`;
      progress(rows);
      if (keyframes.length < 2) throw e;
      break; // 앞에서 만든 것까지만 보여줌
    }
  }
  progress(rows);
  return keyframes;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ---------- 뷰어 / 모핑 ---------- */

function setupViewer() {
  player = new MorphRenderer($('#stage'));
  $('#years').addEventListener('input', (e) => {
    stopAnim();
    renderAt(Number(e.target.value));
  });
  $('#play').addEventListener('click', () => {
    const max = lastAge();
    if (anim) return stopAnim();
    const from = state.years >= max - 0.01 ? 0 : state.years;
    renderAt(from);
    animateTo(max, (max - from) * 450);
  });
  $('#savePng').addEventListener('click', savePng);
  $('#saveVideo').addEventListener('click', saveVideo);
}

function showViewer(keyframes) {
  state.keyframes = keyframes;
  player.clearTextures();
  player.setTriangles(triangulate(keyframes.map((k) => k.pts)));

  const max = lastAge();
  $('#years').max = max;
  $('#ticks').innerHTML = keyframes.map((k) => `<button data-age="${k.age}">${k.age === 0 ? '지금' : `${k.age}년 후`}</button>`).join('');
  $('#ticks').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) animateTo(Number(b.dataset.age));
  };

  const strip = $('#strip');
  strip.innerHTML = '';
  for (const k of keyframes) {
    const fig = document.createElement('figure');
    fig.dataset.age = k.age;
    const c = document.createElement('canvas');
    c.width = 152;
    c.height = 228;
    c.getContext('2d').drawImage(k.canvas, 0, 0, c.width, c.height);
    const cap = document.createElement('figcaption');
    cap.textContent = k.age === 0 ? '지금' : `+${k.age}년`;
    fig.append(c, cap);
    fig.addEventListener('click', () => animateTo(k.age));
    strip.appendChild(fig);
  }

  $('#viewer').hidden = false;
  renderAt(0);
  $('#viewer').scrollIntoView({ behavior: 'smooth' });
}

function lastAge() {
  return state.keyframes.at(-1).age;
}

function renderAt(y) {
  const ks = state.keyframes;
  y = Math.max(0, Math.min(lastAge(), y));
  state.years = y;

  let i = ks.findIndex((k, j) => j < ks.length - 1 && y <= ks[j + 1].age);
  if (i < 0) i = ks.length - 2;
  const A = ks[i], B = ks[i + 1];
  const t = (y - A.age) / (B.age - A.age);
  // 형태는 선형으로, 색은 가운데서 조금 더 빠르게 넘어가게 해서 겹쳐 보이는 구간을 줄임
  const tc = smoothstep(t);
  player.render([{ ...A, weight: 1 - tc }, { ...B, weight: tc }], lerpPts(A.pts, B.pts, t));

  $('#years').value = y;
  const shown = Math.round(y);
  const age = babyYears() + y;
  const ageText = age < 1 ? `${Math.round(age * 12)}개월` : `약 ${Math.floor(age)}세`;
  $('#ageBadge').innerHTML = y < 0.05 ? `지금 <small>${ageText}</small>` : `${shown}년 후 <small>${ageText}</small>`;
  document.querySelectorAll('#ticks button, #strip figure').forEach((el) => {
    el.classList.toggle('on', Math.abs(Number(el.dataset.age) - y) < 0.05);
  });
}

const smoothstep = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function animateTo(target, duration) {
  stopAnim();
  const from = state.years;
  if (Math.abs(target - from) < 0.01) return Promise.resolve();
  duration ??= 700 + Math.abs(target - from) * 110;
  $('#play').textContent = '⏸ 멈춤';
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      renderAt(from + (target - from) * easeInOut(p));
      if (p < 1) anim = { id: requestAnimationFrame(step), resolve };
      else { anim = null; $('#play').textContent = '▶ 자동 재생'; resolve(); }
    };
    anim = { id: requestAnimationFrame(step), resolve };
  });
}

function stopAnim() {
  if (!anim) return;
  cancelAnimationFrame(anim.id);
  anim.resolve();
  anim = null;
  $('#play').textContent = '▶ 자동 재생';
}

/* ---------- 저장 ---------- */

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function savePng() {
  $('#stage').toBlob((b) => download(b, `grow-up_plus${Math.round(state.years)}y.png`), 'image/png');
}

async function saveVideo() {
  const btn = $('#saveVideo');
  const canvas = $('#stage');
  if (!canvas.captureStream || !window.MediaRecorder) return alert('이 브라우저는 영상 저장을 지원하지 않아요 (Chrome 권장)');
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  btn.disabled = true;
  btn.textContent = '🎬 녹화 중…';

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));

  renderAt(0);
  rec.start();
  const hold = () => new Promise((r) => setTimeout(r, 900));
  await hold();
  for (const k of state.keyframes.slice(1)) {
    await animateTo(k.age, 1600);
    await hold();
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  download(new Blob(chunks, { type: mime }), `grow-up.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
  btn.disabled = false;
  btn.textContent = '🎬 성장 영상 저장';
}
