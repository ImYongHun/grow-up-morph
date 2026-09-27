# 우리 아이 성장 미리보기 👶 → 🧑

아기 · 엄마 · 아빠 사진을 올리면 5 / 10 / 15 / 20년 후 얼굴을 만들고,
슬라이더나 연도 버튼을 누르면 얼굴이 **스윽 자연스럽게 모핑**되며 바뀌는 로컬 웹앱입니다.

- 빌드 도구·npm 패키지 없음 — Node 서버 파일 하나 + 정적 프론트엔드
- API 키 없이도 동작하는 **로컬 모핑** 모드, 사실적인 결과를 위한 **AI(OpenAI / Gemini)** 모드
- 사진은 브라우저와 로컬 서버에서만 처리되며, AI 모드일 때만 선택한 API로 전송됩니다

---

## 빠른 시작

### 요구사항

- **Node.js 18 이상** (`node -v` 로 확인) — 내장 `fetch`, `FormData`, `Blob` 사용
- **WebGL을 지원하는 최신 브라우저** (Chrome / Safari / Edge)
- 인터넷 연결 — 처음 실행 시 브라우저가 얼굴 인식 모델(MediaPipe, 약 4MB)을 CDN에서 받아옴

### 실행

```bash
git clone https://github.com/<계정>/<저장소>.git
cd <저장소>

npm start          # → http://localhost:5173
# 또는 개발 모드(파일 변경 시 서버 자동 재시작)
npm run dev
```

`npm install` 은 필요 없습니다. 브라우저에서 <http://localhost:5173> 을 열고 사진 3장을 올린 뒤
**생성** 버튼을 누르면 됩니다. 키 없이 실행하면 로컬 모핑 모드만 활성화됩니다.

포트를 바꾸려면 `.env` 에 `PORT=8080` 처럼 지정하거나 `PORT=8080 npm start` 로 실행하세요.

### AI 모드 설정 (선택)

```bash
cp .env.example .env
# .env 를 열어 둘 중 하나(또는 둘 다) 입력
#   OPENAI_API_KEY=sk-...       https://platform.openai.com/api-keys
#   GEMINI_API_KEY=AIza...      https://aistudio.google.com/apikey
npm start   # 키를 바꿨으면 서버 재시작
```

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | – | OpenAI API 키 |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | 이미지 편집 모델 |
| `OPENAI_IMAGE_QUALITY` | `medium` | `low` / `medium` / `high` (high는 비싸고 느림) |
| `OPENAI_INPUT_FIDELITY` | `high` | 입력 얼굴 보존력. 모델이 지원하지 않으면 빈 값 |
| `GEMINI_API_KEY` | – | Google AI Studio API 키 |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | 이미지 생성 모델 |
| `PORT` | `5173` | 서버 포트 |

- **OpenAI**: 이미지 모델(gpt-image-1)은 조직 인증(Verify Organization)이 필요할 수 있습니다
  → platform.openai.com › Settings › Organization › General. 결제수단 등록 필요.
  1회(4장) 비용은 quality=medium 기준 대략 수백 원 수준.
- **Gemini**: 이미지 생성 모델은 무료 티어가 없거나 제한적일 수 있어 결제 설정이 필요할 수 있습니다.
- 생성된 원본 이미지는 `output/` 폴더에 저장됩니다 (git에는 올라가지 않음).

> ⚠️ `.env` 에는 API 키가 들어 있으므로 `.gitignore` 로 제외되어 있습니다. 절대 커밋하지 마세요.

---

## 생성 방식 2가지

| 방식 | 필요한 것 | 특징 |
|---|---|---|
| **로컬 모핑** | 없음 | 부모 얼굴형·피부를 수학적으로 섞은 "평균 얼굴". 즉시, 무료. 머리카락/배경이 겹쳐 보이는 등 사실감은 낮음 |
| **AI (OpenAI / Gemini)** | API 키 | 사실적인 5·10·15·20년 후 사진 4장 생성 → 그 사이를 모핑. 이전 나이 결과를 다음 생성에 참고로 넣어 같은 아이처럼 보이게 함 |

---

## 프로젝트 구성

```
.
├── server.mjs        의존성 없는 Node HTTP 서버 (정적 파일 서빙 + AI API 프록시)
├── package.json      npm start / npm run dev 스크립트
├── .env.example      환경 변수 템플릿 (복사해서 .env 로 사용)
├── public/           브라우저에서 실행되는 프론트엔드 (빌드 없음, ES 모듈)
│   ├── index.html    화면 (사진 업로드, 옵션, 결과 스테이지)
│   ├── style.css     스타일
│   ├── app.js        업로드·생성 흐름·타임라인 슬라이더·이미지 저장
│   ├── face.js       MediaPipe 얼굴 랜드마크(478점) 검출, 눈 기준 정렬, 머리/배경 제어점, 삼각분할
│   └── morph.js      WebGL 삼각형 메쉬 워핑 + 크로스페이드 렌더러
└── output/           AI 생성 결과 저장 폴더 (자동 생성, git 제외)
```

### 서버 (`server.mjs`)

| 엔드포인트 | 설명 |
|---|---|
| `GET /` , `GET /*` | `public/` 정적 파일 서빙 |
| `GET /api/config` | 사용 가능한 AI 제공자(키 유무)와 모델 이름 반환 |
| `POST /api/generate` | 아기·엄마·아빠(+이전 나이 결과) 이미지와 옵션을 받아 OpenAI 또는 Gemini로 한 장 생성 |

API 키는 서버에만 보관되고 브라우저로 노출되지 않습니다. 서버는 `127.0.0.1` 에만 바인딩되어
같은 컴퓨터에서만 접속할 수 있습니다.

### 동작 흐름

```
사진 업로드 ─▶ face.js: 얼굴 랜드마크 검출 → 두 눈 위치 기준으로 512×768 정렬
            │
            ├─ 로컬 모드: 부모 얼굴형 쪽으로 점을 이동 + 아기/부모 텍스처를 나이별 비율로 섞어 키프레임 생성
            └─ AI 모드  : /api/generate 를 5→10→15→20년 순서로 호출 (이전 결과를 참고 이미지로 전달)
                          → 결과 사진도 같은 방식으로 정렬
            │
            ▼
키프레임(0·5·10·15·20년) ─▶ morph.js: 슬라이더 값에 따라 인접한 두 키프레임의
                                      제어점을 보간하고, 두 이미지를 그 형태로 휘게 만든 뒤 섞어서 렌더링
```

모핑 원리: 모든 사진을 두 눈 위치가 같도록 정렬 → 얼굴 랜드마크 + 머리 둘레 + 테두리 점으로
삼각분할(Delaunator) → 슬라이더 값에 따라 점 위치를 보간하고 두 이미지를 그 형태로 휘게 만든 뒤 섞습니다.

### 외부 라이브러리 (CDN, 설치 불필요)

- [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) — 얼굴 랜드마크 검출
- [`delaunator`](https://www.npmjs.com/package/delaunator) — 들로네 삼각분할

---

## 좋은 결과를 위한 사진 팁

- **정면**, 눈을 뜨고, 얼굴이 크게 나온 사진 (선글라스·모자·손 가림 X)
- 밝고 고른 조명, 가능하면 단순한 배경
- 아이폰 HEIC 사진은 Chrome에서 안 열릴 수 있음 → JPG로 변환하거나 Safari 사용

## 문제 해결

- **"얼굴을 찾지 못했어요"** → 더 정면이고 얼굴이 큰 사진으로 교체
- **AI 버튼이 비활성화됨** → `.env` 에 키가 있는지 확인 후 서버 재시작 (터미널에 `사용 가능` 표시 확인)
- **OpenAI 403 / organization must be verified** → 위의 조직 인증 절차 진행
- **포트 사용 중(EADDRINUSE)** → `PORT=5174 npm start`
