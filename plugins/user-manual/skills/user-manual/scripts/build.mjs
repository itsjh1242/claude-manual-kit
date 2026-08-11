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
// 인쇄 배율이 이 아래로 내려가면 캡처 속 글자를 읽기 어렵다고 보고 경고
const MIN_TEXT_SCALE = 0.4;

const HELP = `기능별 원고(Markdown) + 캡처 PNG → PDF 사용 설명서 (Typst)

사용법:
  node build.mjs --manuscript <dir> --captures <dir> --out <file.pdf> [옵션]

옵션:
  --manuscript <dir>  원고 디렉토리 (doc.json + NN-*.md, 파일명 순서 = 기능 번호)
  --captures <dir>    캡처 PNG 디렉토리 (capture.mjs 출력)
  --out <file.pdf>    출력 PDF 경로
  --specs <dir>       캡처 명세 디렉토리 — "화면 구성" 번호와 뱃지 개수 대조에 사용
  --keep-typ          생성된 .typ 빌드 디렉토리를 지우지 않고 남김 (디버그용)
  --help              이 도움말

마지막 줄에 BUILD: OK 또는 BUILD: FAIL — 사유 를 출력한다.`;

class BuildError extends Error {}

function parseArgs(argv) {
  const opts = { manuscript: null, captures: null, out: null, specs: null, keepTyp: false };
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
  return { file, title: meta.title, sections };
}

// ── Markdown 인라인 → Typst 마크업 ─────────────────────────────

const XREF_RE = /→\s*기능\s*(\d+)(?:\s*참고)?/g;

function escapeTypst(s) {
  return s.replace(/[\\#$*_`@<>[\]~=]/g, (c) => '\\' + c);
}

function inlineToTypst(text, ctx) {
  const xref = (s) =>
    escapeTypst(s).replace(XREF_RE, (_, n) => {
      ctx.xrefs.push({ n: Number(n), file: ctx.file });
      return `#featref(${n})`;
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

async function pngWidth(file) {
  const buf = await readFile(file);
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) {
    throw new BuildError(`${file}: PNG 형식이 아닙니다`);
  }
  return buf.readUInt32BE(16);
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
    features.push(parseManuscript(f, await readFile(path.join(opts.manuscript, f), 'utf8')));
  }

  // 캡처 명세: 뱃지 개수 대조용
  const specBadges = new Map();
  if (opts.specs) {
    for (const f of (await readdir(opts.specs)).filter((f) => f.endsWith('.json'))) {
      try {
        const spec = JSON.parse(await readFile(path.join(opts.specs, f), 'utf8'));
        if (spec.id) specBadges.set(spec.id, (spec.annotations?.badges ?? []).length);
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

  for (const [idx, feat] of features.entries()) {
    const n = idx + 1;

    for (const s of feat.sections) {
      for (const b of s.blocks) {
        if (b.type !== 'image') continue;
        b.ref = b.ref.replace(/\.png$/, '');
        referenced.add(b.ref);
        try {
          await readFile(path.join(opts.captures, `${b.ref}.png`));
        } catch {
          errors.push(`${feat.file}: 참조된 캡처가 없습니다 — ${b.ref}.png (${opts.captures})`);
        }
      }
    }

    // "화면 구성" 번호 개수 = 캡처 뱃지 개수 (뱃지-설명 불일치를 잡는 결정론적 검사)
    const screen = feat.sections.find((s) => s.key === 'screen');
    if (screen) {
      const itemCount = screen.blocks.filter((b) => b.type === 'olist')
        .reduce((sum, b) => sum + b.items.length, 0);
      const images = screen.blocks.filter((b) => b.type === 'image');
      if (images.length === 0 && itemCount > 0) {
        warn(`${feat.file}: "화면 구성"에 캡처가 없어 뱃지 개수를 대조할 수 없습니다`);
      } else if (specBadges.size > 0 || opts.specs) {
        let badgeSum = 0;
        let checkable = images.length > 0;
        for (const img of images) {
          if (!specBadges.has(img.ref)) {
            if (opts.specs) warn(`${feat.file}: 캡처 "${img.ref}" 의 명세를 찾지 못해 뱃지 개수를 대조할 수 없습니다`);
            checkable = false;
          } else {
            badgeSum += specBadges.get(img.ref);
          }
        }
        if (checkable && itemCount !== badgeSum) {
          errors.push(
            `${feat.file}: "화면 구성" 번호 ${itemCount}개 ≠ 캡처 뱃지 ${badgeSum}개 ` +
            `(${images.map((i) => i.ref).join(', ')}) — 목록과 뱃지가 1:1 이어야 합니다`,
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
    imageWidth: () => 100,
  };

  // 이미지 폭: CSS px(=픽셀/2, deviceScaleFactor 2) 기준으로 자연 크기 이하로만 축소
  const widthCache = new Map();
  for (const id of referenced) {
    const file = path.join(opts.captures, `${id}.png`);
    try {
      const cssW = (await pngWidth(file)) / 2;
      const naturalPt = cssW * 0.75;
      const pct = Math.min(100, Math.round((naturalPt / CONTENT_WIDTH_PT) * 100));
      widthCache.set(id, pct);
      const scale = Math.min(1, CONTENT_WIDTH_PT / naturalPt);
      if (scale < MIN_TEXT_SCALE) {
        warn(
          `캡처 ${id}.png 가 가로로 너무 넓어 ${Math.round(scale * 100)}% 로 축소됩니다 — ` +
          `글자가 안 읽힐 수 있으니 clip 으로 영역을 좁히거나 화면을 나눠 찍으세요 (하한 ${MIN_TEXT_SCALE * 100}%)`,
        );
      }
    } catch {
      widthCache.set(id, 100);
    }
  }
  ctx.imageWidth = (id) => widthCache.get(id) ?? 100;

  const featureTypst = features.map((feat, idx) => featureToTypst(feat, idx + 1, ctx));

  // 상호 참조 검증: → 기능 N 의 N 이 실존해야 한다
  for (const x of ctx.xrefs) {
    if (x.n < 1 || x.n > features.length) {
      errors.push(`${x.file}: "→ 기능 ${x.n}" — 기능은 1~${features.length}번까지만 있습니다`);
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

  console.log(`✔ ${features.length}개 기능 → ${outAbs}`);
  console.log(`BUILD: OK${warnings.length ? ` (경고 ${warnings.length}건)` : ''}`);
}

main().catch((e) => {
  const msg = e instanceof BuildError ? e.message : (e?.stack ?? String(e));
  console.error(`✘ ${msg}`);
  console.log(`BUILD: FAIL — ${e?.message?.split('\n')[0] ?? e}`);
  process.exit(1);
});
