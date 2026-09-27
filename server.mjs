// 의존성 없는 로컬 서버: 정적 파일 + AI 이미지 생성 프록시 (API 키는 .env 에만 보관)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const OUTPUT = path.join(ROOT, 'output');

loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 5173);
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';
const OPENAI_FIDELITY = process.env.OPENAI_INPUT_FIDELITY ?? 'high';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('요청이 너무 큽니다');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('이미지 형식이 올바르지 않습니다');
  return { mime: m[1], b64: m[2], buf: Buffer.from(m[2], 'base64') };
}

function buildPrompt({ targetAge, sex, dadRatio, years, hasPrev, prevAge }) {
  const who = sex === 'girl' ? 'girl' : sex === 'boy' ? 'boy' : 'child';
  const grown = targetAge >= 18 ? (sex === 'girl' ? 'young woman' : sex === 'boy' ? 'young man' : 'young adult') : who;
  const dadPct = Math.round(dadRatio * 100);
  const lean =
    dadPct === 50 ? 'resembling both parents equally'
    : dadPct > 50 ? `resembling the father about ${dadPct}% and the mother about ${100 - dadPct}%`
    : `resembling the mother about ${100 - dadPct}% and the father about ${dadPct}%`;
  return [
    'Image 1 is a baby. Image 2 is the baby\'s mother. Image 3 is the baby\'s father.',
    hasPrev ? `Image 4 is the same child already grown to about ${prevAge} years old — stay consistent with it.` : '',
    `Create a photorealistic photo of this exact same child ${years} years later, now a ${grown} about ${targetAge} years old.`,
    'Preserve the child\'s identity from the baby photo (eye shape and color, eyebrows, nose, lips, face structure, skin tone, hair color)',
    `and let the features mature naturally with genetic inheritance from both parents, ${lean}.`,
    'Framing: front-facing head-and-shoulders portrait, face centered, looking straight into the camera, both eyes open, calm neutral expression with mouth closed,',
    'soft even studio lighting, plain light gray background, realistic skin texture, no makeup, no glasses, no hat, no text or watermark.',
  ].filter(Boolean).join(' ');
}

async function generateOpenAI(images, prompt) {
  const form = new FormData();
  form.append('model', OPENAI_MODEL);
  form.append('prompt', prompt);
  form.append('size', '1024x1536');
  form.append('quality', OPENAI_QUALITY);
  form.append('n', '1');
  if (OPENAI_FIDELITY) form.append('input_fidelity', OPENAI_FIDELITY);
  images.forEach((img, i) => {
    const ext = img.mime.split('/')[1].replace('jpeg', 'jpg');
    form.append('image[]', new Blob([img.buf], { type: img.mime }), `ref${i + 1}.${ext}`);
  });
  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI 오류 (${r.status}): ${j.error?.message || r.statusText}`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI 응답에 이미지가 없습니다');
  return `data:image/png;base64,${b64}`;
}

async function generateGemini(images, prompt) {
  const parts = [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.b64 } }))];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini 오류 (${r.status}): ${j.error?.message || r.statusText}`);
  const out = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const data = out?.inlineData || out?.inline_data;
  if (!data) {
    const reason = j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '알 수 없음';
    throw new Error(`Gemini 응답에 이미지가 없습니다 (사유: ${reason})`);
  }
  return `data:${data.mimeType || data.mime_type || 'image/png'};base64,${data.data}`;
}

function saveOutput(dataUrl, years) {
  try {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const { buf, mime } = parseDataUrl(dataUrl);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(OUTPUT, `${stamp}_plus${years}y.${mime.includes('png') ? 'png' : 'jpg'}`), buf);
  } catch (e) {
    console.warn('결과 저장 실패:', e.message);
  }
}

async function handleGenerate(req, res) {
  const body = await readJson(req);
  const provider = body.provider;
  if (provider === 'openai' && !OPENAI_KEY) return sendJson(res, 400, { error: 'OPENAI_API_KEY 가 .env 에 없습니다' });
  if (provider === 'gemini' && !GEMINI_KEY) return sendJson(res, 400, { error: 'GEMINI_API_KEY 가 .env 에 없습니다' });
  if (provider !== 'openai' && provider !== 'gemini') return sendJson(res, 400, { error: '알 수 없는 provider' });

  const images = [body.baby, body.mom, body.dad].map(parseDataUrl);
  if (body.prev) images.push(parseDataUrl(body.prev));
  const prompt = buildPrompt({
    targetAge: body.targetAge,
    sex: body.sex,
    dadRatio: Number(body.dadRatio ?? 0.5),
    years: body.years,
    hasPrev: !!body.prev,
    prevAge: body.prevAge,
  });
  console.log(`[generate] ${provider} +${body.years}년 (약 ${body.targetAge}세)`);
  const t0 = Date.now();
  const image = provider === 'openai' ? await generateOpenAI(images, prompt) : await generateGemini(images, prompt);
  console.log(`[generate] 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  saveOutput(image, body.years);
  sendJson(res, 200, { image });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return sendJson(res, 200, {
        openai: !!OPENAI_KEY,
        gemini: !!GEMINI_KEY,
        openaiModel: OPENAI_MODEL,
        geminiModel: GEMINI_MODEL,
      });
    }
    if (req.method === 'POST' && req.url === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  👶  Grow-Up Morph  →  http://localhost:${PORT}\n`);
  console.log(`  OpenAI: ${OPENAI_KEY ? `사용 가능 (${OPENAI_MODEL})` : '키 없음'}`);
  console.log(`  Gemini: ${GEMINI_KEY ? `사용 가능 (${GEMINI_MODEL})` : '키 없음'}`);
  console.log('  (키가 없어도 로컬 모핑 모드는 동작합니다)\n');
});
