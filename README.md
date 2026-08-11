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
   └─ skills/user-manual/SKILL.md
```

버전은 별도로 관리하지 않는다 — 커밋 SHA가 버전 역할을 하며, push 즉시 갱신된다.
