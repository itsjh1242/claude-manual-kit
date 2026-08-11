# 막혔을 때 대처

증상 → 원인 후보 → 조치. 한 기능에서 3회 시도로 안 풀리면 그 기능을 `_목차.md` 에
"보류(사유)"로 남기고 다음 기능으로 넘어간다. 루프 전체를 세우지 않는다.

## 캡처 (capture.mjs)

### 로그인 페이지로 리다이렉트된다
- 토큰 키 이름이 다름 → 인증 코드에서 실제 storage key 를 다시 확인
  (`localStorage.getItem` 검색). sessionStorage / cookie 인 경우도 있다.
- 토큰 형식을 검사하는 앱 → payload 있는 가짜 JWT 로:
  `header.eyJyb2xlIjoiYWRtaW4iLCJleHAiOjk5OTk5OTk5OTl9.sig` 처럼 exp/role 을 채운다.
- `/api/me` 류 검증 호출이 mock 안 됨 → 경고 목록을 보고 routes 에 추가.

### 화면이 로딩 상태로 찍힌다
- mock 안 된 API 가 pending → "매칭 안 된 API 호출" 경고를 routes 에 추가.
- 응답 형태 불일치(배열 vs `{items:[]}`) → 렌더 코드가 읽는 형태를 다시 확인.
- websocket/polling 으로 networkidle 미도달 → 경고는 무시해도 되나 화면이 비면
  `actions` 에 `waitFor` 로 핵심 요소 등장을 명시.

### annotations selector 를 못 찾는다 (CAPTURE: FAIL)
- 렌더 후 DOM 을 직접 확인: actions 에 `wait` 를 잠깐 넣고 `--headed` 로 실행하거나,
  캡처를 annotations 없이 한 번 찍어 PNG 로 실제 화면을 본다.
- 동적 클래스(css-modules 해시) → `data-testid`, role, `text=` 셀렉터로 바꾼다.
- 요소가 조건부 렌더 → 그 상태를 만드는 fixture/actions 가 먼저다.

### 뱃지가 엉뚱한 곳을 가리킨다
- selector 가 여러 요소와 일치(경고 확인) → 더 구체적인 selector 로.
- 리사이즈 후 위치가 변하는 요소(sticky, fixed) → `hide` 하거나 clip 범위를 조정.

### 빈 화면 경고 / 폰트 깨짐
- SPA 라우팅이 base-url 기준 상대경로와 안 맞음 → url 을 해시 라우팅(`/#/...`) 등
  실제 접근 경로로.
- 캡처 속 한글이 □ → 로컬 폰트 문제. 페이지가 웹폰트를 쓰면 대기 시간을 늘린다.

## 빌드 (build.mjs)

- `typst 를 찾을 수 없습니다` → 안내된 설치 명령을 실행한다 (자동 설치 안 함).
- `"화면 구성" 번호 N개 ≠ 캡처 뱃지 M개` → 원고 목록과 명세 badges 를 대조해
  한쪽을 고친다. 뱃지 없는 요소를 목록에 쓰지 않았는지 확인.
- `→ 기능 N — 기능은 1~K번까지만` → Phase 3 에서 번호를 일괄 확정했는지 확인.
  기능 순서를 바꿨다면 모든 원고의 참조를 다시 훑는다.
- `typst compile 실패` → `--keep-typ` 로 .typ 를 남겨 에러 줄을 확인.
  대부분 원고의 특수문자가 원인 — 해당 문구를 단순화한다.
- 이미지가 너무 작게 나옴(축소 경고) → 명세에 `clip` 을 넣어 관련 영역만 찍거나,
  화면을 상/하로 나눠 두 장으로 찍는다.

## dev 서버

- 포트 추론 실패 → `package.json` scripts 의 dev/start 명령을 실행하고
  stdout 에서 포트를 읽는다. 그래도 모호하면 이때만 사용자에게 묻는다.
- 서버가 API 프록시 없이 프론트만 서빙 → 괜찮다. API 는 전부 route mock 이라
  백엔드가 없어도 캡처된다. 오히려 mock 누락이 경고로 드러나 편하다.
- HTTPS 전용/셀프사인 인증서 → capture.mjs 는 chromium 을 쓰므로 http dev 서버를
  우선 찾는다. 없으면 빌드 산출물을 `npx serve` 등으로 정적 서빙해 캡처한다.
