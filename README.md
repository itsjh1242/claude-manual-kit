# claude-manual-kit

Claude Code 플러그인 마켓플레이스. 코드베이스에서 주석 달린 화면 그림 기반 PDF 사용 설명서를 생성하는 플러그인을 제공한다.

## 설치

```
/plugin marketplace add itsjh1242/claude-manual-kit
/plugin install user-manual@manual-kit
```

## 플러그인

| 플러그인 | 설명 |
|---|---|
| `user-manual` | 코드베이스를 분석해 주석 달린 화면 그림 기반 PDF 사용 설명서를 생성 |

## 구조

```
claude-manual-kit/
├─ .claude-plugin/marketplace.json
└─ plugins/user-manual/
   ├─ .claude-plugin/plugin.json
   └─ skills/user-manual/
      ├─ SKILL.md              # 전체 워크플로 (Phase 0~4)
      ├─ references/           # Phase별 상세 — 조사·원고 작성·트러블슈팅
      └─ scripts/                # 캡처 → PDF 파이프라인 — scripts/README.md 참고
         ├─ capture.mjs          # 캡처 명세 JSON → 주석 입힌 PNG (Playwright)
         ├─ build.mjs            # 원고(.md) + PNG → PDF (Typst 0.15.x)
         ├─ template.typ         # PDF 템플릿 (색·글꼴은 상단 cfg 만 수정)
         ├─ specs/               # 캡처 명세 샘플
         └─ samples/manuscript/  # 원고 샘플
```

버전은 별도로 관리하지 않는다 — 커밋 SHA가 버전 역할을 하며, push 즉시 갱신된다.
