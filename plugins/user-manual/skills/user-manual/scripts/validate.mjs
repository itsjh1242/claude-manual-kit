#!/usr/bin/env node
// validate.mjs — 최종 검증. 개인정보 패턴 스캔 + 〔확인:〕 마커 ↔ _질문.md 대조.
// LLM 재량 없이 결정론적으로 판정한다. 규칙은 README.md 참고.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const HELP = `원고·fixture 최종 검증 — 개인정보 패턴 스캔 + 〔확인:〕 마커 대조

사용법:
  node validate.mjs --manuscript <dir> --specs <dir> [옵션]

옵션 (--manuscript / --specs / --captures 는 여러 번 지정 가능):
  --manuscript <dir>  원고 디렉토리 — *.md 본문을 스캔
  --specs <dir>       캡처 명세 디렉토리 — fixture(mock 데이터) JSON 을 스캔
  --captures <dir>    캡처 디렉토리 — 파일명을 스캔
  --questions <file>  _질문.md 경로 — 〔확인:〕 마커와 1:1 대조
  --manual-md <file>  MANUAL.md 경로 — "## validate-whitelist" 절의 허용값 추가
  --help              이 도움말

검사 내용:
  1. 개인정보 패턴: 이메일, 휴대폰(010-), 일반 전화, 카드번호, 주민등록번호 형식.
     화이트리스트(기본: example.com 계열 이메일, 010-0000-0000, 010-1234-5678)에
     있는 값은 허용. MANUAL.md 의 "## validate-whitelist" 절에 "- 값" 으로 추가 가능.
     "@도메인" 형태 항목은 그 도메인의 모든 이메일을 허용한다.
  2. 원고의 〔확인: 항목명〕 마커 ↔ _질문.md 항목이 1:1 이어야 한다.

마지막 줄에 VALIDATE: OK 또는 VALIDATE: FAIL — 사유. 실패 시 exit code 1.`;

class ValidateError extends Error {}

function parseArgs(argv) {
  const opts = { manuscripts: [], specs: [], captures: [], questions: null, manualMd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new ValidateError(`${a} 뒤에 값이 필요합니다`);
      return argv[++i];
    };
    switch (a) {
      case '--manuscript': opts.manuscripts.push(next()); break;
      case '--specs': opts.specs.push(next()); break;
      case '--captures': opts.captures.push(next()); break;
      case '--questions': opts.questions = next(); break;
      case '--manual-md': opts.manualMd = next(); break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new ValidateError(`알 수 없는 옵션: ${a} (--help 참고)`);
    }
  }
  if (opts.manuscripts.length === 0) throw new ValidateError('--manuscript 가 필요합니다 (--help 참고)');
  return opts;
}

// ── 개인정보 패턴 ──────────────────────────────────────────────
// 순서가 우선순위: 같은 위치를 여러 패턴이 잡으면 앞의 것으로 한 번만 보고

const PATTERNS = [
  { name: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: '주민등록번호', re: /\b\d{6}-[1-4]\d{6}\b/g },
  { name: '카드번호', re: /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g },
  { name: '휴대폰 번호', re: /01[016789][-. ]?\d{3,4}[-. ]?\d{4}/g },
  { name: '전화번호', re: /0\d{1,2}[-. ]\d{3,4}[-. ]\d{4}/g },
];

const DEFAULT_WHITELIST = ['010-0000-0000', '010-1234-5678', '02-0000-0000'];
const DEFAULT_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'];

async function loadWhitelist(manualMd, warn) {
  const wl = {
    exact: new Set(DEFAULT_WHITELIST),
    digits: new Set(DEFAULT_WHITELIST.map((v) => v.replace(/\D/g, ''))),
    emailDomains: [...DEFAULT_EMAIL_DOMAINS],
  };
  if (!manualMd) return wl;
  let src;
  try {
    src = await readFile(manualMd, 'utf8');
  } catch {
    warn(`${manualMd} 를 읽을 수 없어 기본 화이트리스트만 사용합니다`);
    return wl;
  }
  const lines = src.split('\n');
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s.*whitelist/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^[-*]\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const v = m[1].trim();
    if (v.startsWith('@')) {
      wl.emailDomains.push(v.slice(1).toLowerCase());
    } else {
      wl.exact.add(v);
      const d = v.replace(/\D/g, '');
      if (d) wl.digits.add(d);
    }
  }
  return wl;
}

function isWhitelisted(match, kind, wl) {
  const m = match.trim();
  if (wl.exact.has(m)) return true;
  const digits = m.replace(/\D/g, '');
  if (digits && wl.digits.has(digits)) return true;
  if (kind === '이메일') {
    const dom = (m.toLowerCase().split('@')[1] ?? '');
    if (wl.emailDomains.some((d) => dom === d || dom.endsWith('.' + d))) return true;
  }
  return false;
}

// 텍스트 한 덩어리를 스캔해 화이트리스트 밖의 매치를 반환
function scanText(text, wl) {
  const hits = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const claimed = [];
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const [s, e] = [m.index, m.index + m[0].length];
        if (claimed.some(([cs, ce]) => s < ce && e > cs)) continue;
        claimed.push([s, e]);
        if (!isWhitelisted(m[0], name, wl)) hits.push({ kind: name, value: m[0], line: i + 1 });
      }
    }
  }
  return hits;
}

// ── 〔확인:〕 마커 ↔ _질문.md ──────────────────────────────────

const MARKER_RE = /〔확인:\s*([^〕]+)〕/g;

function extractMarkers(text, file) {
  const markers = [];
  for (const [i, line] of text.split('\n').entries()) {
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(line)) !== null) {
      markers.push({ name: m[1].trim(), where: `${file}:${i + 1}` });
    }
  }
  return markers;
}

function extractQuestionItems(text) {
  // 형식: - [ ] 항목명 — 부가 설명
  const items = [];
  for (const line of text.split('\n')) {
    const m = /^[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line.trim());
    if (m) items.push(m[1].split('—')[0].trim());
  }
  return items;
}

// ── 메인 ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    console.warn(`⚠ ${msg}`);
  };

  const wl = await loadWhitelist(opts.manualMd, warn);

  // 1. 개인정보 스캔 — 원고 본문
  const allMarkers = [];
  for (const dir of opts.manuscripts) {
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
      const file = path.join(dir, f);
      const text = await readFile(file, 'utf8');
      for (const h of scanText(text, wl)) {
        errors.push(`개인정보 의심 (${h.kind}): "${h.value}" — ${file}:${h.line}`);
      }
      allMarkers.push(...extractMarkers(text, file));
    }
  }

  // 1. 개인정보 스캔 — fixture(캡처 명세 JSON)
  for (const dir of opts.specs) {
    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      warn(`명세 디렉토리 ${dir} 를 읽을 수 없습니다`);
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      for (const h of scanText(await readFile(file, 'utf8'), wl)) {
        errors.push(`개인정보 의심 (${h.kind}): "${h.value}" — ${file}:${h.line} (fixture)`);
      }
    }
  }

  // 1. 개인정보 스캔 — 캡처 파일명
  for (const dir of opts.captures) {
    let files;
    try {
      files = await readdir(dir);
    } catch {
      warn(`캡처 디렉토리 ${dir} 를 읽을 수 없습니다`);
      continue;
    }
    for (const f of files) {
      for (const h of scanText(f, wl)) {
        errors.push(`개인정보 의심 (${h.kind}): 캡처 파일명 "${f}" — ${dir}`);
      }
    }
  }

  // 2. 〔확인:〕 마커 ↔ _질문.md 1:1 대조
  let questionItems = [];
  let questionsRead = false;
  if (opts.questions) {
    try {
      questionItems = extractQuestionItems(await readFile(opts.questions, 'utf8'));
      questionsRead = true;
    } catch {
      if (allMarkers.length > 0) {
        errors.push(`원고에 〔확인:〕 마커가 ${allMarkers.length}개 있는데 ${opts.questions} 를 읽을 수 없습니다`);
      }
    }
  } else if (allMarkers.length > 0) {
    errors.push(`원고에 〔확인:〕 마커가 ${allMarkers.length}개 있습니다 — --questions 로 _질문.md 를 지정해 대조하세요`);
  }
  if (questionsRead) {
    const markerNames = new Set(allMarkers.map((m) => m.name));
    const itemNames = new Set(questionItems);
    for (const m of allMarkers) {
      if (!itemNames.has(m.name)) {
        errors.push(`〔확인: ${m.name}〕 마커가 _질문.md 에 없습니다 — ${m.where}`);
      }
    }
    for (const q of questionItems) {
      if (!markerNames.has(q)) {
        errors.push(`_질문.md 항목 "${q}" 에 대응하는 〔확인:〕 마커가 원고에 없습니다`);
      }
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`✘ ${e}`);
    console.log(`VALIDATE: FAIL — ${errors.length}건: ${errors[0]}`);
    process.exit(1);
  }
  console.log(`VALIDATE: OK${warnings.length ? ` (경고 ${warnings.length}건)` : ''}`);
}

main().catch((e) => {
  const msg = e instanceof ValidateError ? e.message : (e?.stack ?? String(e));
  console.error(`✘ ${msg}`);
  console.log(`VALIDATE: FAIL — ${e?.message?.split('\n')[0] ?? e}`);
  process.exit(1);
});
