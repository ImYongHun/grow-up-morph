// 얼굴 랜드마크 검출 + 눈 기준 정렬 + 모핑용 제어점 생성
import { FaceLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import Delaunator from 'https://cdn.jsdelivr.net/npm/delaunator@5.0.1/+esm';

// 정렬된 결과 캔버스 크기 (2:3 세로 인물 사진 비율)
export const W = 512;
export const H = 768;
const EYE_Y = H * 0.44;
const EYE_DIST = W * 0.25;

// MediaPipe 얼굴 윤곽 인덱스 (이마 → 오른쪽 → 턱 → 왼쪽)
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const IRIS_A = 468; // 한쪽 홍채 중심
const IRIS_B = 473; // 다른 쪽 홍채 중심

let landmarkerPromise;
function getLandmarker() {
  landmarkerPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    const create = (delegate) => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate,
      },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    return create('GPU').catch(() => create('CPU'));
  })();
  return landmarkerPromise;
}

export function warmup() {
  return getLandmarker();
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다'));
    img.src = src;
  });
}

// 너무 큰 사진은 줄여서 dataURL 로 (서버 전송·검출 속도용)
export function downscale(img, max = 1024, type = 'image/jpeg') {
  const s = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const c = document.createElement('canvas');
  c.width = Math.round((img.naturalWidth || img.width) * s);
  c.height = Math.round((img.naturalHeight || img.height) * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, 0.92);
}

async function detect(source) {
  const lm = await getLandmarker();
  const res = lm.detect(source);
  const face = res.faceLandmarks?.[0];
  if (!face) return null;
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  return face.map((p) => [p.x * w, p.y * h]);
}

// 사진 → 눈 위치가 고정된 W×H 캔버스 + 변환된 랜드마크
export async function alignFace(img, label = '사진') {
  const pts = await detect(img);
  if (!pts) throw new Error(`${label}에서 얼굴을 찾지 못했어요. 정면 얼굴이 잘 보이는 사진을 써주세요.`);

  // 화면상 왼쪽 눈 / 오른쪽 눈 정리
  let l = pts[IRIS_A], r = pts[IRIS_B];
  if (l[0] > r[0]) [l, r] = [r, l];
  const L = [W / 2 - EYE_DIST / 2, EYE_Y];
  const R = [W / 2 + EYE_DIST / 2, EYE_Y];

  const s = Math.hypot(R[0] - L[0], R[1] - L[1]) / Math.hypot(r[0] - l[0], r[1] - l[1]);
  const th = Math.atan2(R[1] - L[1], R[0] - L[0]) - Math.atan2(r[1] - l[1], r[0] - l[0]);
  const a = s * Math.cos(th), b = s * Math.sin(th);
  const tx = L[0] - (a * l[0] - b * l[1]);
  const ty = L[1] - (b * l[0] + a * l[1]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  // 사진 밖으로 삐져나간 영역은 테두리 평균색으로 채움
  ctx.fillStyle = edgeColor(img);
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const aligned = pts.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty]);
  return { canvas, pts: withHeadPoints(aligned) };
}

function edgeColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (x > 0 && x < 15 && y > 0) continue; // 위/좌/우 테두리만
    const i = (y * 16 + x) * 4;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  return `rgb(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0})`;
}

// 얼굴 밖(머리카락·목·어깨)도 함께 움직이도록 윤곽을 바깥으로 확장한 점 + 캔버스 테두리 고정점
function withHeadPoints(face) {
  const oval = FACE_OVAL.map((i) => face[i]);
  const cx = oval.reduce((s, p) => s + p[0], 0) / oval.length;
  const cy = oval.reduce((s, p) => s + p[1], 0) / oval.length;
  const clamp = (v, max) => Math.min(max - 2, Math.max(2, v));
  const extra = [];
  for (const k of [1.3, 1.7]) {
    for (const [x, y] of oval) extra.push([clamp(cx + (x - cx) * k, W), clamp(cy + (y - cy) * k, H)]);
  }
  const border = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    border.push([(W * i) / n, 0], [(W * i) / n, H]);
    if (i > 0 && i < n) border.push([0, (H * i) / n], [W, (H * i) / n]);
  }
  return [...face, ...extra, ...border];
}

// 여러 얼굴 형태의 평균으로 한 번만 삼각분할 → 모든 프레임이 같은 메쉬를 공유
export function triangulate(shapes) {
  const n = shapes[0].length;
  const flat = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (const s of shapes) { x += s[i][0]; y += s[i][1]; }
    flat[i * 2] = x / shapes.length;
    flat[i * 2 + 1] = y / shapes.length;
  }
  return new Delaunator(flat).triangles;
}

export function lerpPts(A, B, t) {
  return A.map((p, i) => [p[0] + (B[i][0] - p[0]) * t, p[1] + (B[i][1] - p[1]) * t]);
}
