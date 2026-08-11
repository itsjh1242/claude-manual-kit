#!/usr/bin/env node
// build.mjs — 기능별 원고(Markdown) + 캡처 PNG → Typst → PDF 사용 설명서.
// 원고 형식과 검증 규칙은 README.md 참고. Typst 0.15.x 에서 검증되었다.

import { readFile, readdir, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PINNED_TYPST = '0.15';

// A4 (210mm) - 좌우 여백 40mm = 170mm ≈ 482pt. 캡처는 CSS 1px ≈ 0.75pt 로 환산
const CONTENT_WIDTH_PT = 482;
// 본문 세로는 253mm ≈ 717pt. 이미지는 분할이 안 되므로 남은 공간보다 크면 통째로
// 다음 페이지로 밀려 반쪽 빈 페이지가 생긴다. 기능 제목 + 개요 + 진입 경로 뒤에
// 남는 공간(약 460pt)에 들어가는 높이까지만 허용하고 넘으면 폭을 줄인다
const MAX_IMAGE_HEIGHT_PT = 460;
// 인쇄 배율이 이 아래로 내려가면 캡처 속 글자를 읽기 어렵다고 보고 경고
const MIN_TEXT_SCALE = 0.4;

const HELP = `기능별 원고(Markdown) + 캡처 PNG → PDF 사용 설명서 (Typst)

사용법:
  node build.mjs --manuscript <dir> --captures <dir> --out <file.pdf> [옵션]

옵션:
  --manuscript <dir>  원고 디렉토리 (doc.json + NN-*.md, 파일명 순서 = 기능 번호)
  --captures <dir>    캡처 PNG 디렉토리 (capture.mjs 출력)
  --out <file.pdf>    출력 PDF 경로
  --specs <dir>       캡처 명세 디렉토리 — "화면 구성" 번호와 뱃지 번호 대조에 사용
  --keep-typ          생성된 .typ 빌드 디렉토리를 지우지 않고 남김 (디버그용)
  --quiet             진행 줄 생략 — 경고·에러와 마지막 판정 줄만 출력
  --help              이 도움말

마지막 줄에 BUILD: OK 또는 BUILD: FAIL — 사유 를 출력한다.`;

class BuildError extends Error {}

function parseArgs(argv) {
  const opts = { manuscript: null, captures: null, out: null, specs: null, keepTyp: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new BuildError(`${a} 뒤에 값이 필요합니다`);
      return argv[++i];
    };
    switch (a) {
      case '--manuscript': opts.manuscript = next(); break;
      case '--captures': opts.captures = next(); break;
      case '--out': opts.out = next(); break;
      case '--specs': opts.specs = next(); break;
      case '--keep-typ': opts.keepTyp = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new BuildError(`알 수 없는 옵션: ${a} (--help 참고)`);
    }
  }
  if (!opts.manuscript) throw new BuildError('--manuscript 가 필요합니다 (--help 참고)');
  if (!opts.captures) throw new BuildError('--captures 가 필요합니다');
  if (!opts.out) throw new BuildError('--out 이 필요합니다');
  return opts;
}

function checkTypst(warn) {
  const r = spawnSync('typst', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new BuildError(
      'typst 를 찾을 수 없습니다. 설치 후 다시 실행하세요:\n' +
      '    macOS:   brew install typst\n' +
      '    Windows: winget install --id Typst.Typst\n' +
      '    기타:    cargo install typst-cli --locked\n' +
      `  이 도구는 typst ${PINNED_TYPST}.x 에서 검증되었습니다`,
    );
  }
  const m = /typst (\d+)\.(\d+)/.exec(r.stdout);
  if (!m) {
    warn(`typst 버전을 해석할 수 없습니다: "${r.stdout.trim()}"`);
    return;
  }
  const ver = `${m[1]}.${m[2]}`;
  if (ver !== PINNED_TYPST) {
    warn(`typst ${ver} 감지 — 검증된 버전은 ${PINNED_TYPST}.x 입니다. 0.x 는 마이너 릴리스마다 호환성이 깨질 수 있으니 결과를 확인하세요`);
  }
}

// ── 원고 파싱 ──────────────────────────────────────────────────

const SECTION_KEYS = {
  '이 기능은?': 'intro',
  '주의': 'caution',
  '어디에 있나요?': 'path',
  '화면 구성': 'screen',
  '방법': 'steps',
  '그러면?': 'result',
  '안 될 때는?': 'trouble',
};

function parseFrontmatter(src, file) {
  const lines = src.split('\n');
  if (lines[0]?.trim() !== '---') throw new BuildError(`${file}: 파일이 frontmatter(---)로 시작해야 합니다`);
  const meta = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  if (i >= lines.length) throw new BuildError(`${file}: frontmatter 가 닫히지 않았습니다`);
  if (!meta.title) throw new BuildError(`${file}: frontmatter 에 title 이 필요합니다`);
  return { meta, body: lines.slice(i + 1) };
}

// 섹션 본문을 블록(문단/목록/인용/이미지) 단위로 나눈다
function parseBlocks(lines, file, section) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (img) {
      blocks.push({ type: 'image', alt: img[1].trim(), ref: img[2].trim() });
      i++;
      continue;
    }
    if (/^\d+[.)]\s+/.test(line.trim())) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        let item = lines[i].trim().replace(/^\d+[.)]\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i])) {
          item += ' ' + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: 'olist', items });
      continue;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        let item = lines[i].trim().replace(/^[-*]\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s/.test(lines[i])) {
          item += ' ' + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: 'ulist', items });
      continue;
    }
    if (/^>\s?/.test(line.trim())) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quote.join(' ') });
      continue;
    }
    if (/^#{1,6}\s/.test(line.trim())) {
      throw new BuildError(`${file} [${section}]: 섹션 안에 하위 제목(#)은 쓸 수 없습니다 — "${line.trim()}"`);
    }
    // 문단: 빈 줄까지 이어붙임
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
      !/^(!\[|\d+[.)]\s|[-*]\s|>|#{1,6}\s)/.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'para', text: para.join(' ') });
  }
  return blocks;
}

function parseManuscript(file, src) {
  const { meta, body } = parseFrontmatter(src, file);
  const sections = [];
  let current = null;

  for (const line of body) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      const raw = h[1].trim();
      const name = raw.replace(/^[⚠️\s]+/u, '').trim();
      const key = SECTION_KEYS[name];
      if (!key) {
        throw new BuildError(
          `${file}: 알 수 없는 섹션 "## ${raw}" — 허용: ${Object.keys(SECTION_KEYS).map((s) => `"${s}"`).join(', ')}`,
        );
      }
      if (sections.some((s) => s.key === key)) throw new BuildError(`${file}: 섹션 "## ${name}" 이 중복됩니다`);
      current = { key, name, lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() !== '') {
        throw new BuildError(`${file}: 첫 섹션(##) 앞에는 내용을 둘 수 없습니다 — "${line.trim()}"`);
      }
      continue;
    }
    current.lines.push(line);
  }

  for (const s of sections) s.blocks = parseBlocks(s.lines, file, s.name);
  return { file, title: meta.title, meta, sections };
}

// 캡처 id 이름 규약: <독자>-<기능번호 2자리>-<상태> (예: admin-03-empty)
const ID_CONVENTION = /^[a-z0-9]+-\d{2}-[a-z0-9][a-z0-9-]*$/;

// ── Markdown 인라인 → Typst 마크업 ─────────────────────────────

// 상호 참조는 id 기반: → [members]. escapeTypst 가 대괄호를 이스케이프한 뒤
// 치환하므로 \[ \] 형태를 매칭한다. 뒤따르는 "참고"는 featref 가 렌더하므로 삼킨다.
const XREF_RE = /→\s*\\\[([A-Za-z0-9_-]+)\\\](?:\s*참고)?/g;
const LEGACY_XREF_RE = /→\s*기능\s*\d+/;

function escapeTypst(s) {
  return s.replace(/[\\#$*_`@<>[\]~=]/g, (c) => '\\' + c);
}

function inlineToTypst(text, ctx) {
  const xref = (s) =>
    escapeTypst(s).replace(XREF_RE, (m, id) => {
      ctx.xrefs.push({ id, file: ctx.file });
      const n = ctx.idMap.get(id);
      return n ? `#featref(${n})` : m;
    });
  return text
    .split(/(`[^`]+`)/)
    .map((seg) => {
      if (/^`[^`]+`$/.test(seg)) {
        const code = seg.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `#raw("${code}")`;
      }
      return seg
        .split(/(\*\*[^*]+\*\*)/)
        .map((s2) => (/^\*\*[^*]+\*\*$/.test(s2) ? `#strong[${xref(s2.slice(2, -2))}]` : xref(s2)))
        .join('');
    })
    .join('');
}

// ── 블록 → Typst ───────────────────────────────────────────────

function blocksToTypst(blocks, ctx, { screen = false } = {}) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'para':
        out.push(inlineToTypst(b.text, ctx) + '\n');
        break;
      case 'olist': {
        const items = b.items.map((it) => `+ ${inlineToTypst(it, ctx)}`).join('\n');
        out.push(screen ? `#screen-list[\n${items}\n]\n` : items + '\n');
        break;
      }
      case 'ulist':
        out.push(b.items.map((it) => `- ${inlineToTypst(it, ctx)}`).join('\n') + '\n');
        break;
      case 'quote':
        out.push(`#note[${inlineToTypst(b.text, ctx)}]\n`);
        break;
      case 'image': {
        const width = ctx.imageWidth(b.ref);
        const caption = b.alt ? `, caption: "${b.alt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
        out.push(`#screenshot("captures/${b.ref}.png", width: ${width}%${caption})\n`);
        break;
      }
    }
  }
  return out.join('\n');
}

function featureToTypst(feature, n, ctx) {
  const parts = [];
  const get = (key) => feature.sections.find((s) => s.key === key);
  const c = { ...ctx, file: feature.file };

  const order = ['intro', 'caution', 'path', 'screen', 'steps', 'result', 'trouble'];
  for (const key of order) {
    const s = get(key);
    if (!s) continue;
    const body = blocksToTypst(s.blocks, c, { screen: key === 'screen' });
    switch (key) {
      case 'intro': parts.push(body); break;
      case 'caution': parts.push(`#warnbox[\n${body}]`); break;
      case 'result': parts.push(`#resultbox[\n${body}]`); break;
      default: parts.push(`== ${escapeTypst(s.name)}\n\n${body}`);
    }
  }
  const title = escapeTypst(feature.title);
  return `#feature(${n}, [${title}])[\n\n${parts.join('\n')}\n]\n`;
}

// ── PNG 크기 읽기 (IHDR) ───────────────────────────────────────

async function pngSize(file) {
  const buf = await readFile(file);
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) {
    throw new BuildError(`${file}: PNG 형식이 아닙니다`);
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── 메인 ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    console.warn(`⚠ ${msg}`);
  };

  checkTypst(warn);

  // 문서 메타
  const docJsonPath = path.join(opts.manuscript, 'doc.json');
  let doc;
  try {
    doc = JSON.parse(await readFile(docJsonPath, 'utf8'));
  } catch (e) {
    throw new BuildError(`${docJsonPath} 을 읽을 수 없습니다 (${e.message}) — 문서 메타(title 등)가 필요합니다`);
  }
  if (!doc.title) throw new BuildError(`${docJsonPath}: title 이 필요합니다`);

  // 원고: 파일명 순서 = 기능 번호
  const mdFiles = (await readdir(opts.manuscript))
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort();
  if (mdFiles.length === 0) throw new BuildError(`${opts.manuscript} 에 원고(*.md)가 없습니다`);

  const features = [];
  for (const f of mdFiles) {
    const src = await readFile(path.join(opts.manuscript, f), 'utf8');
    const feat = parseManuscript(f, src);
    feat.raw = src;
    // 기능 id: frontmatter id 우선, 없으면 파일명 NN-<id>.md 의 <id>
    feat.id = feat.meta.id ?? (/^\d+-(.+)\.md$/.exec(f)?.[1] ?? f.replace(/\.md$/, ''));
    features.push(feat);
  }

  // 캡처 명세: 뱃지 개수 대조용
  const specBadges = new Map();
  if (opts.specs) {
    for (const f of (await readdir(opts.specs)).filter((f) => f.endsWith('.json'))) {
      try {
        const spec = JSON.parse(await readFile(path.join(opts.specs, f), 'utf8'));
        if (spec.id) specBadges.set(spec.id, (spec.annotations?.badges ?? []).map((b) => b.n));
      } catch {
        warn(`명세 ${f} 를 읽을 수 없어 뱃지 검사에서 제외합니다`);
      }
    }
  } else {
    warn('--specs 미지정 — "화면 구성" 번호와 캡처 뱃지 개수 대조를 건너뜁니다');
  }

  // ── 검증 ──
  const errors = [];
  const referenced = new Set();
  const conventionWarned = new Set();

  const idMap = new Map();
  const idFiles = new Map();
  for (const [i, feat] of features.entries()) {
    if (idFiles.has(feat.id)) {
      errors.push(`${feat.file}: 기능 id "${feat.id}" 가 ${idFiles.get(feat.id)} 와 중복됩니다 — 파일명 NN-<id>.md 의 <id> 가 겹치면 frontmatter 의 id 로 구분하세요`);
    } else {
      idFiles.set(feat.id, feat.file);
      idMap.set(feat.id, i + 1);
    }
  }

  for (const [idx, feat] of features.entries()) {
    const n = idx + 1;

    if (LEGACY_XREF_RE.test(feat.raw)) {
      errors.push(`${feat.file}: "→ 기능 N" 번호 참조는 지원하지 않습니다 — id 형식 "→ [기능id]" 를 쓰세요 (예: → [members])`);
    }

    for (const s of feat.sections) {
      for (const b of s.blocks) {
        if (b.type !== 'image') continue;
        b.ref = b.ref.replace(/\.png$/, '');
        referenced.add(b.ref);
        if (!ID_CONVENTION.test(b.ref) && !conventionWarned.has(b.ref)) {
          conventionWarned.add(b.ref);
          warn(`캡처 id "${b.ref}" 가 이름 규약 <독자>-<기능번호 2자리>-<상태> 를 벗어납니다 (예: admin-03-empty) — 동작은 하지만 새 캡처는 규약을 따르세요`);
        }
        try {
          await readFile(path.join(opts.captures, `${b.ref}.png`));
        } catch {
          errors.push(`${feat.file}: 참조된 캡처가 없습니다 — ${b.ref}.png (${opts.captures})`);
        }
      }
    }

    // "화면 구성" 검사: 이미지(들)와 바로 뒤에 오는 번호 목록이 한 묶음이다.
    // 묶음마다 캡처 뱃지 n 의 합집합이 정확히 1..(그 목록의 항목 수)여야 한다.
    // 이미지마다 목록을 새로 시작하면 각 캡처 뱃지도 1부터, 이미지 여러 장 뒤에
    // 목록 하나면 n 을 이어 부여한 것으로 본다. 뱃지-설명 불일치를 잡는 결정론적 검사.
    const screen = feat.sections.find((s) => s.key === 'screen');
    if (screen && opts.specs) {
      const groups = [];
      let cur = null;
      for (const b of screen.blocks) {
        if (b.type === 'image') {
          if (!cur || cur.items > 0) {
            cur = { images: [], items: 0 };
            groups.push(cur);
          }
          cur.images.push(b);
        } else if (b.type === 'olist') {
          if (!cur) {
            cur = { images: [], items: 0 };
            groups.push(cur);
          }
          cur.items += b.items.length;
        }
      }
      for (const g of groups) {
        if (g.images.length === 0) {
          if (g.items > 0) warn(`${feat.file}: "화면 구성"에 캡처 없는 번호 목록이 있어 뱃지를 대조할 수 없습니다`);
          continue;
        }
        let checkable = true;
        const ns = [];
        for (const img of g.images) {
          if (!specBadges.has(img.ref)) {
            warn(`${feat.file}: 캡처 "${img.ref}" 의 명세를 찾지 못해 뱃지 번호를 대조할 수 없습니다`);
            checkable = false;
          } else {
            ns.push(...specBadges.get(img.ref));
          }
        }
        if (!checkable) continue;
        if (g.items === 0) {
          if (ns.length > 0) {
            errors.push(
              `${feat.file}: 캡처(${g.images.map((i) => i.ref).join(', ')})에 뱃지 ${ns.length}개가 있는데 ` +
              `뒤따르는 번호 목록이 없습니다 — 뱃지마다 설명 항목이 있어야 합니다`,
            );
          }
          continue;
        }
        const count = new Map();
        for (const v of ns) count.set(v, (count.get(v) ?? 0) + 1);
        const dup = [...count].filter(([, c]) => c > 1).map(([v]) => v);
        const outOfRange = [...new Set(ns)].filter((v) => !Number.isInteger(v) || v < 1 || v > g.items);
        const missing = [];
        for (let k = 1; k <= g.items; k++) if (!count.has(k)) missing.push(k);
        if (dup.length || outOfRange.length || missing.length) {
          const parts = [];
          if (missing.length) parts.push(`누락 ${missing.join(',')}`);
          if (dup.length) parts.push(`중복 ${dup.join(',')}`);
          if (outOfRange.length) parts.push(`범위 밖 ${outOfRange.join(',')}`);
          errors.push(
            `${feat.file}: "화면 구성" 목록 ${g.items}개 항목 ↔ 캡처 뱃지 번호 불일치 ` +
            `(${g.images.map((i) => i.ref).join(', ')}) — ${parts.join(' / ')}. ` +
            `이미지(들)와 바로 뒤 목록이 한 묶음이며 뱃지 n 합집합이 1..${g.items} 이어야 합니다`,
          );
        }
      }
    }

    // 주의는 방법보다 앞에
    const keys = feat.sections.map((s) => s.key);
    if (keys.includes('caution') && keys.includes('steps') && keys.indexOf('caution') > keys.indexOf('steps')) {
      warn(`${feat.file}: "주의" 섹션이 "방법" 뒤에 있습니다 — 되돌릴 수 없는 동작은 방법보다 먼저 알려야 합니다`);
    }
  }

  // 캡처는 있는데 어느 원고도 참조하지 않는 경우
  for (const f of (await readdir(opts.captures)).filter((f) => f.endsWith('.png'))) {
    const id = f.replace(/\.png$/, '');
    if (!referenced.has(id)) warn(`캡처 ${f} 를 참조하는 원고가 없습니다`);
  }

  // ── Typst 생성 (검증 통과 여부와 무관하게 상호 참조 수집을 위해 변환은 수행) ──
  const ctx = {
    xrefs: [],
    file: null,
    idMap,
    imageWidth: () => 100,
  };

  // 이미지 크기: CSS px(=픽셀/2, deviceScaleFactor 2) 기준으로 자연 크기 이하로만 축소.
  // 폭은 본문 폭, 높이는 MAX_IMAGE_HEIGHT_PT 를 상한으로 한다
  const widthCache = new Map();
  for (const id of referenced) {
    const file = path.join(opts.captures, `${id}.png`);
    try {
      const { w, h } = await pngSize(file);
      const naturalW = (w / 2) * 0.75;
      const naturalH = (h / 2) * 0.75;
      let widthPt = Math.min(naturalW, CONTENT_WIDTH_PT);
      const heightAtWidth = naturalH * (widthPt / naturalW);
      if (heightAtWidth > MAX_IMAGE_HEIGHT_PT) {
        widthPt *= MAX_IMAGE_HEIGHT_PT / heightAtWidth;
        warn(
          `캡처 ${id}.png 가 세로로 길어 페이지에 맞게 ${Math.round((widthPt / naturalW) * 100)}% 로 축소합니다 — ` +
          `그대로 두면 이미지가 다음 페이지로 밀려 빈 페이지가 생깁니다. ` +
          `글자가 작아지니 clip 으로 영역을 좁히거나 화면을 나눠 찍는 것을 권장`,
        );
      }
      widthCache.set(id, Math.round((widthPt / CONTENT_WIDTH_PT) * 100));
      const scale = widthPt / naturalW;
      if (scale < MIN_TEXT_SCALE) {
        warn(
          `캡처 ${id}.png 의 인쇄 배율이 ${Math.round(scale * 100)}% 로 하한(${MIN_TEXT_SCALE * 100}%)보다 낮습니다 — ` +
          `글자가 안 읽힐 수 있으니 clip 으로 영역을 좁히거나 화면을 나눠 찍으세요`,
        );
      }
    } catch {
      widthCache.set(id, 100);
    }
  }
  ctx.imageWidth = (id) => widthCache.get(id) ?? 100;

  const featureTypst = features.map((feat, idx) => featureToTypst(feat, idx + 1, ctx));

  // 상호 참조 검증: → [id] 의 id 가 실존해야 한다
  for (const x of ctx.xrefs) {
    if (!idMap.has(x.id)) {
      errors.push(`${x.file}: "→ [${x.id}]" — 존재하지 않는 기능 id 입니다 (사용 가능: ${[...idMap.keys()].join(', ')})`);
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`✘ ${e}`);
    console.log(`BUILD: FAIL — 검증 실패 ${errors.length}건: ${errors[0]}`);
    process.exit(1);
  }

  // ── 빌드 디렉토리 구성 → typst compile ──
  const outAbs = path.resolve(opts.out);
  const buildDir = path.join(path.dirname(outAbs), '.manual-build');
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(path.join(buildDir, 'captures'), { recursive: true });
  await copyFile(path.join(SCRIPT_DIR, 'template.typ'), path.join(buildDir, 'template.typ'));
  for (const id of referenced) {
    await copyFile(path.join(opts.captures, `${id}.png`), path.join(buildDir, 'captures', `${id}.png`));
  }

  const meta = ['title', 'subtitle', 'product', 'version', 'date', 'author']
    .filter((k) => doc[k])
    .map((k) => `  ${k}: "${String(doc[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",`)
    .join('\n');
  const mainTyp =
    `#import "template.typ": *\n\n#show: manual.with(\n${meta}\n)\n\n${featureTypst.join('\n')}`;
  await writeFile(path.join(buildDir, 'main.typ'), mainTyp);

  await mkdir(path.dirname(outAbs), { recursive: true });
  const r = spawnSync('typst', ['compile', 'main.typ', outAbs], { cwd: buildDir, encoding: 'utf8' });
  if (r.stderr?.trim()) console.error(r.stderr.trim());
  if (r.status !== 0) {
    console.log(`BUILD: FAIL — typst compile 실패 (${opts.keepTyp ? buildDir : '--keep-typ 로 .typ 를 남겨 확인하세요'})`);
    process.exit(1);
  }
  if (!opts.keepTyp) await rm(buildDir, { recursive: true, force: true });

  if (!opts.quiet) console.log(`✔ ${features.length}개 기능 → ${outAbs}`);
  console.log(`BUILD: OK${warnings.length ? ` (경고 ${warnings.length}건)` : ''}`);
}

main().catch((e) => {
  const msg = e instanceof BuildError ? e.message : (e?.stack ?? String(e));
  console.error(`✘ ${msg}`);
  console.log(`BUILD: FAIL — ${e?.message?.split('\n')[0] ?? e}`);
  process.exit(1);
});
