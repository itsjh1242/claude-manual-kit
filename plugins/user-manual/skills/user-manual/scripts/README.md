# 사용 설명서 생성 스크립트

코드베이스 → 주석 달린 화면 캡처 → PDF 사용 설명서. 두 단계로 나뉜다.

```
캡처 명세(.json) ──ⓐ capture.mjs──▶ 주석 입힌 PNG ─┐
                                                     ├─ⓑ build.mjs──▶ PDF
기능별 원고(.md) ────────────────────────────────────┘   (Typst)
                └──────ⓒ validate.mjs — 개인정보·〔확인:〕 마커 최종 검증
```

## 요구사항

```bash
npm install
npx playwright install chromium   # ⓐ 캡처용
brew install typst                # ⓑ PDF 조립용 (Windows: winget install --id Typst.Typst)
```

**Typst 는 0.15.x 로 고정** (0.15.1 에서 검증). 아직 0.x 라 마이너 릴리스마다
호환성이 깨질 수 있어, build.mjs 가 실행 시 `typst --version` 을 확인하고
메이저/마이너가 다르면 경고한다. 미설치면 설치 명령을 안내하고 중단한다 (자동 설치 없음).

Typst 를 엔진으로 고른 이유: 단일 바이너리라 시스템 라이브러리 의존이 없고
(weasyprint 의 pango 문제 회피), 목차 페이지 번호를 네이티브로 지원한다
(Chromium 인쇄의 한계 회피).

---

# ⓐ 캡처 엔진 (capture.mjs)

캡처 명세 JSON 하나를 주석(뱃지·박스·확대) 오버레이가 입혀진 PNG 한 장으로 만든다.

핵심 설계: 실제 계정 로그인 없이, Playwright가 브라우저 밖에서 네트워크를 가로채
"로그인된 상태"를 만들고 화면을 캡처한다. 프로젝트 코드는 일절 건드리지 않는다.

- 토큰은 `addInitScript` 로 localStorage/sessionStorage 에 주입 (페이지 스크립트보다 먼저 실행)
- API 응답은 `page.route` 로 인터셉트해 mock 데이터를 반환
- 시간은 `Date` 오버라이드로 고정 (`freezeTime`)
- 주석은 픽셀에 그리지 않고 캡처 직전 DOM 오버레이로 주입 — 좌표가 어긋날 수 없다

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
| `--quiet` | 진행 줄 생략 — 경고·에러와 판정 줄만 출력 | off |

출력 파일명은 `<out>/<spec.id>.png`. 마지막 줄에 `CAPTURE: OK` 또는
`CAPTURE: FAIL — 사유` 를 출력하고, 실패 시 exit code 1.

## 캡처 명세 스키마

명세 하나가 캡처 한 장에 대응한다. `id` 와 `url` 만 필수, 나머지는 전부 선택.

```jsonc
{
  // 출력 파일명 (필수). 규약: <독자>-<기능번호 2자리>-<상태>
  // 예: admin-03-empty, admin-03-filled. 벗어나면 build 가 경고한다
  "id": "admin-02-filled",
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
    // 번호 원. 요소를 가리지 않는 바깥 모서리에 자동 배치.
    // 원고의 "화면 구성" 목록과 대조: 한 섹션에 들어가는 모든 캡처의 n 합집합이
    // 정확히 1..(항목 수)여야 한다. 캡처가 여러 장이면 n 을 이어서 부여
    // (첫 장 1,2 / 둘째 장 3,4). 중복·누락·범위 초과는 build 에러
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

### 캡처 동작 순서

1. chromium 컨텍스트 생성 (deviceScaleFactor 2 — 레티나 화질)
2. `addInitScript` 로 토큰 주입 + Date 고정
3. `page.route` 등록 — **매칭 안 되는 API 호출은 경고로 출력** (놓친 엔드포인트를 찾는 단서)
4. goto → networkidle 대기
5. actions 순차 실행
6. hide 적용
7. 뷰포트 높이를 문서 전체 높이로 확장 (`fullPage` 는 스티칭 좌표 버그 때문에 쓰지 않음)
8. 주석 오버레이 DOM 주입
9. screenshot (`animations: 'disabled'`)

### 캡처 실패 규칙

- **annotations / clip 의 selector 가 요소를 못 찾으면 즉시 에러로 중단한다.**
  조용히 넘어가면 뱃지가 엉뚱한 곳을 가리키고, 그 오류는 사람 눈으로만 잡힌다.
  요소가 있어도 숨김 상태(크기 0)면 같은 이유로 에러다.
- `hide` 의 selector 미매칭은 경고만 (페이지에 따라 없을 수 있는 요소이므로).
- 본문 텍스트가 거의 없으면(30자 미만) 빈 화면 의심 경고.
- `--all` 모드에서는 실패한 명세를 스킵하고 계속 진행, 마지막에 실패 목록 보고.

---

# ⓑ PDF 조립 (build.mjs)

기능별 원고(Markdown)와 캡처 PNG 를 Typst 로 변환해 PDF 를 만든다.
문서 하나 = 독자 하나(관리자용, 사용자용 등)이고, 기능이 파일명 순서대로 나열된다.

## 사용법

```bash
node build.mjs --manuscript samples/manuscript --captures captures/ \
  --specs specs/ --out manual.pdf
```

| 옵션 | 설명 |
|---|---|
| `--manuscript <dir>` | 원고 디렉토리 (`doc.json` + `NN-*.md`, 파일명 순서 = 기능 번호) |
| `--captures <dir>` | 캡처 PNG 디렉토리 (capture.mjs 출력) |
| `--out <file.pdf>` | 출력 PDF 경로 |
| `--specs <dir>` | 캡처 명세 디렉토리 — 뱃지 번호 대조에 사용 (권장) |
| `--keep-typ` | 생성된 `.typ` 빌드 디렉토리를 남김 (디버그용) |
| `--quiet` | 진행 줄 생략 — 경고·에러와 판정 줄만 출력 |

마지막 줄에 `BUILD: OK` 또는 `BUILD: FAIL — 사유`. 실패 시 exit code 1.

## 원고 형식

**Markdown + 고정 섹션 이름 + YAML frontmatter.** 이 형식을 고른 이유:

- Claude 가 자연스럽게 생성하는 형식이 마크다운이라 생성 오류율이 낮다.
- 섹션 이름을 고정 어휘(아래 7개)로 제한하고 **모르는 섹션은 에러**로 처리하므로,
  기계 파싱에 모호함이 없다 — 오타나 형식 이탈이 조용히 누락되는 대신 빌드가 실패한다.
- 캡처 참조가 `![캡션](캡처id)` 하나뿐이라 명세·PNG 와의 대조 검사가 결정론적이다.

디렉토리 구조 (전체 예시는 [`samples/manuscript/`](samples/manuscript/)):

```
manuscript/
├─ doc.json        # 문서 메타: title(필수), subtitle, product, version, date, author
├─ 01-login.md     # 파일명 사전순 = 기능 번호 (01 → 기능 1)
├─ 02-members.md   # _ 로 시작하는 파일은 무시
└─ 03-approve.md
```

기능 파일 하나의 구조 — frontmatter 의 `title` 만 필수, 섹션은 전부 선택:

```markdown
---
title: 회원 목록 확인하기
---

## 이 기능은?
한두 문장 개요. 기능 제목 바로 아래에 놓인다.

## ⚠️ 주의
되돌릴 수 없는 동작·전제 조건. 주황 "주의" 상자로 렌더링.
("방법" 뒤에 두면 경고가 뜬다 — 위험은 절차보다 먼저 알려야 하므로)

## 어디에 있나요?
진입 경로.

## 화면 구성
![회원 관리 화면](admin-01-members)

1. **회원 검색** — 이름으로 회원을 찾습니다.
2. **신청 승인** — 가입 신청을 승인합니다.

## 방법
1. 단계별 절차. 버튼명은 **강조**.

## 그러면?
성공 시 결과. 초록 "결과" 상자로 렌더링.

## 안 될 때는?
- 실패 케이스와 안내 문구.
```

지원 문법:

- `**강조**`, `` `코드` ``, 번호 목록, 글머리 목록, 문단
- `> 인용` → 파랑 "참고" 상자
- `![캡션](캡처id)` → 캡처 삽입. 어느 섹션이든, 몇 장이든 가능. 위치는 쓴 자리 그대로
- `→ [기능id]` → "→ 기능 N 참고 (5쪽)" 로 렌더되는 페이지 링크.
  기능 id = 파일명 `NN-<id>.md` 의 `<id>` (frontmatter `id:` 로 재정의 가능).
  **id 기반이므로 기능 순서를 바꿔도(파일명 번호 변경) 참조가 깨지지 않는다.**
  구형 `→ 기능 N` 번호 참조는 에러
- 섹션 안의 하위 제목(`#`)은 금지 (에러)

## 빌드 검증 (결정론적 검사)

| 검사 | 결과 |
|---|---|
| 원고가 참조한 캡처 PNG 가 없음 | **에러** |
| 캡처는 있는데 어느 원고도 참조 안 함 | 경고 |
| **"화면 구성" 섹션의 캡처 뱃지 n 합집합 ≠ 정확히 1..(항목 수)** | **에러** — 누락/중복/범위 밖을 구분해 표시. 뱃지-설명 불일치를 잡는 핵심 검사 |
| `→ [기능id]` 의 id 가 실존하지 않음 / 구형 `→ 기능 N` 참조 | **에러** |
| 기능 id 중복 | **에러** — frontmatter `id:` 로 구분 |
| 알 수 없는 섹션 이름 / frontmatter 누락 | **에러** |
| 캡처 id 가 이름 규약 `<독자>-<기능번호 2자리>-<상태>` 를 벗어남 | 경고 |
| "주의"가 "방법" 뒤에 있음 | 경고 |
| 캡처가 가로로 너무 넓어 인쇄 배율 40% 미만 | 경고 — clip 으로 좁히거나 화면 분할 권장 |

## 템플릿 커스터마이징 (template.typ)

색상·글꼴은 전부 `template.typ` 상단의 `cfg` 딕셔너리에 모여 있다.
**여기만 고치면 된다:**

```typst
#let cfg = (
  fonts: ("Apple SD Gothic Neo", "Noto Sans CJK KR", ...),  // 앞에서부터 폴백
  font-size: 10.5pt,
  accent: rgb("#2563eb"),   // 표지·기능 제목·상호 참조
  badge: rgb("#ff3b30"),    // "화면 구성" 번호 원 — 캡처 뱃지 색과 맞출 것
  note-color: ...,          // 참고 상자
  warn-color: ...,          // 주의 상자
  result-color: ...,        // 결과 상자
  ...
)
```

템플릿이 보장하는 것:

- A4, 표지 / 목차(페이지 번호 자동) / 본문 / 뒷표지
- 페이지 하단에 문서명 + 페이지 번호
- 정보 상자 3종 (참고 / 주의 / 결과) — 색·아이콘·레이블로 구분
- 제목·그림이 페이지 경계에서 갈라지지 않음 (sticky + breakable: false)
- 그림은 페이지 폭 이하로만 축소 (작은 캡처는 원본 크기 유지, 확대하지 않음)
- 기능별 자동 페이지 나눔, 목차·상호 참조는 실제 페이지로 하이퍼링크

샘플 원고: [`samples/manuscript/`](samples/manuscript/) ·
샘플 캡처 명세: [`specs/sample-admin-members.json`](specs/sample-admin-members.json) ·
결과물 예시: [`samples/sample-manual.pdf`](samples/sample-manual.pdf)

---

# ⓒ 최종 검증 (validate.mjs)

원고·fixture 에 실제 개인정보가 섞이지 않았는지, 〔확인:〕 마커가 `_질문.md` 와
1:1 인지 결정론적으로 판정한다. PDF 를 내보내기 전 마지막 관문.

```bash
node validate.mjs --manuscript samples/manuscript --specs specs \
  --captures captures --questions docs/manual/_질문.md --manual-md MANUAL.md
```

| 옵션 | 설명 |
|---|---|
| `--manuscript <dir>` | 원고 디렉토리 — `*.md` 본문 스캔 (여러 번 지정 가능) |
| `--specs <dir>` | 캡처 명세 디렉토리 — fixture JSON 스캔 (여러 번 지정 가능) |
| `--captures <dir>` | 캡처 디렉토리 — 파일명 스캔 (여러 번 지정 가능) |
| `--questions <file>` | `_질문.md` 경로 — 마커 대조 |
| `--manual-md <file>` | MANUAL.md 경로 — 화이트리스트 추가분 로드 |

**개인정보 패턴**: 이메일, 휴대폰(010-), 일반 전화, 카드번호(4-4-4-4),
주민등록번호(6-7) 형식. 걸리면 종류·값·파일:줄을 보고하고 FAIL.

**화이트리스트**: 기본으로 example.com/org/net 도메인 이메일, `010-0000-0000`,
`010-1234-5678`, `02-0000-0000` 을 허용. 프로젝트별 추가는 MANUAL.md 에:

```markdown
## validate-whitelist
- 1588-0000                  <!-- 실제로 문서에 실을 대표번호 -->
- @ourservice.com            <!-- @도메인 형태면 그 도메인 이메일 전부 허용 -->
```

**마커 대조**: 원고의 `〔확인: 항목명〕` ↔ `_질문.md` 의 `- [ ] 항목명 — 설명`.
항목명이 정확히 일치해야 하며, 어느 한쪽에만 있으면 FAIL.

마지막 줄에 `VALIDATE: OK` 또는 `VALIDATE: FAIL — 사유`. 실패 시 exit code 1.
