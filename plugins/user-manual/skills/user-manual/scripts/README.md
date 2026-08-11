# 캡처 엔진 (capture.mjs)

캡처 명세 JSON 하나를 주석(뱃지·박스·확대) 오버레이가 입혀진 PNG 한 장으로 만든다.

핵심 설계: 실제 계정 로그인 없이, Playwright가 브라우저 밖에서 네트워크를 가로채
"로그인된 상태"를 만들고 화면을 캡처한다. 프로젝트 코드는 일절 건드리지 않는다.

- 토큰은 `addInitScript` 로 localStorage/sessionStorage 에 주입 (페이지 스크립트보다 먼저 실행)
- API 응답은 `page.route` 로 인터셉트해 mock 데이터를 반환
- 시간은 `Date` 오버라이드로 고정 (`freezeTime`)
- 주석은 픽셀에 그리지 않고 캡처 직전 DOM 오버레이로 주입 — 좌표가 어긋날 수 없다

## 설치

```bash
cd plugins/user-manual/skills/user-manual/scripts
npm install
npx playwright install chromium
```

## 사용법

```bash
# 명세 하나
node capture.mjs --spec specs/admin-01.json --out captures/ --base-url http://localhost:5173

# 디렉토리 일괄 (실패한 명세는 스킵하고 계속, 마지막에 목록 보고)
node capture.mjs --all specs/ --out captures/ --base-url http://localhost:5173
```

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--spec <file>` | 캡처 명세 JSON 하나 | — |
| `--all <dir>` | 디렉토리 안의 모든 `*.json` 명세 실행 | — |
| `--out <dir>` | PNG 출력 디렉토리 | `captures` |
| `--base-url <url>` | 상대 `url` 의 기준 주소 (필수) | — |
| `--viewport <WxH>` | 뷰포트 너비x기본높이 | `1440x900` |
| `--accent-color <c>` | 주석 색상 | `#FF3B30` |
| `--font <css>` | 주석 폰트 패밀리 | 시스템 산세리프 |
| `--timeout <ms>` | 셀렉터·네트워크 대기 타임아웃 | `15000` |
| `--headed` | 브라우저 창을 띄워서 실행 (디버그용) | off |

출력 파일명은 `<out>/<spec.id>.png`. 마지막 줄에 `CAPTURE: OK` 또는
`CAPTURE: FAIL — 사유` 를 출력하고, 실패 시 exit code 1.

## 명세 스키마

명세 하나가 캡처 한 장에 대응한다. `id` 와 `url` 만 필수, 나머지는 전부 선택.

```jsonc
{
  "id": "admin-01-members",          // 출력 파일명 (필수)
  "url": "/admin/members",           // base-url 기준 상대 경로 (필수)

  "auth": {
    // 단일 객체 또는 배열. type: "localStorage" | "sessionStorage"
    "storage": { "type": "localStorage", "key": "accessToken", "value": "mock-jwt" },
    // Playwright addCookies 형식. url/domain 생략 시 base-url 로 채움
    "cookies": []
  },

  // API 인터셉트. pattern 은 Playwright glob (** 는 전부, * 는 / 제외 전부).
  // 앞 항목이 우선. body 가 문자열이면 그대로, 아니면 JSON 직렬화.
  // status 기본 200, contentType 기본 application/json. headers 추가 가능.
  "routes": [
    { "pattern": "**/api/me", "status": 200, "body": { "id": 1, "name": "김관리" } },
    { "pattern": "**/api/members*", "status": 200, "body": [] }
  ],

  // 페이지 로드(networkidle) 후 순차 실행
  "actions": [
    { "type": "click", "selector": "text=신청 승인" },
    { "type": "waitFor", "selector": "[role=dialog]" }
  ],

  // 캡처 전 visibility:hidden 처리 (매칭 없으면 경고 후 건너뜀)
  "hide": [".cookie-banner", "#dev-badge"],

  // new Date() / Date.now() 를 이 시각으로 고정
  "freezeTime": "2026-03-14T09:00:00+09:00",

  "annotations": {
    // 번호 원. 요소를 가리지 않는 바깥 모서리에 자동 배치
    "badges": [ { "n": 1, "selector": "[data-testid=search]" } ],
    // 요소 둘레 테두리
    "boxes":  [ { "selector": "form.filter" } ],
    // 요소를 clone 해 factor 배로 확대, 여백에 배치하고 원본과 선으로 연결
    "zooms":  [ { "selector": "button.icon-only", "factor": 3 } ]
  },

  // 이 요소의 영역만 잘라서 캡처. 주석이 영역 밖에 놓이면 합집합으로 확장됨
  "clip": { "selector": "main" }
}
```

### actions 종류

| type | 필드 | 동작 |
|---|---|---|
| `click` | `selector` | 클릭 (요소 등장을 자동 대기, 클릭 후 networkidle 대기) |
| `fill` | `selector`, `value` | 입력값 채우기 |
| `hover` | `selector` | 마우스 올리기 |
| `press` | `key`, `selector`(선택) | 키 입력 (selector 없으면 페이지 전역) |
| `waitFor` | `selector`, `state`(선택, 기본 `visible`) | 요소 상태 대기 |
| `wait` | `ms` | 고정 시간 대기 (최후의 수단) |

selector 는 Playwright selector 문법 전체를 지원한다 (`text=`, `[role=dialog]`, CSS 등).

## 동작 순서

1. chromium 컨텍스트 생성 (deviceScaleFactor 2 — 레티나 화질)
2. `addInitScript` 로 토큰 주입 + Date 고정
3. `page.route` 등록 — **매칭 안 되는 API 호출은 경고로 출력** (놓친 엔드포인트를 찾는 단서)
4. goto → networkidle 대기
5. actions 순차 실행
6. hide 적용
7. 뷰포트 높이를 문서 전체 높이로 확장 (`fullPage` 는 스티칭 좌표 버그 때문에 쓰지 않음)
8. 주석 오버레이 DOM 주입
9. screenshot (`animations: 'disabled'`)

## 실패 규칙

- **annotations / clip 의 selector 가 요소를 못 찾으면 즉시 에러로 중단한다.**
  조용히 넘어가면 뱃지가 엉뚱한 곳을 가리키고, 그 오류는 사람 눈으로만 잡힌다.
  요소가 있어도 숨김 상태(크기 0)면 같은 이유로 에러다.
- `hide` 의 selector 미매칭은 경고만 (페이지에 따라 없을 수 있는 요소이므로).
- 본문 텍스트가 거의 없으면(30자 미만) 빈 화면 의심 경고.
- `--all` 모드에서는 실패한 명세를 스킵하고 계속 진행, 마지막에 실패 목록 보고.

샘플 명세: [`specs/sample-admin-members.json`](specs/sample-admin-members.json)
