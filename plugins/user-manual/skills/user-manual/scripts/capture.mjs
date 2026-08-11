#!/usr/bin/env node
// capture.mjs — 캡처 명세 JSON 하나를 주석(뱃지·박스·확대) 오버레이가 입혀진 PNG 한 장으로 만든다.
// 실제 계정 로그인 없이 스토리지 주입 + 네트워크 인터셉트로 "로그인된 상태"를 재현하며,
// 프로젝트 코드는 일절 건드리지 않는다. 명세 스키마는 README.md 참고.

import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const HELP = `캡처 명세 JSON → 주석(뱃지·박스·확대) 오버레이가 입혀진 PNG

사용법:
  node capture.mjs --spec <spec.json> --out <dir> --base-url <url> [옵션]
  node capture.mjs --all <specs-dir> --out <dir> --base-url <url> [옵션]

옵션:
  --spec <file>       캡처 명세 JSON 하나를 실행
  --all <dir>         디렉토리 안의 모든 *.json 명세를 실행 (실패한 명세는 스킵하고 계속)
  --out <dir>         PNG 출력 디렉토리 (기본: captures)
  --base-url <url>    명세의 상대 url 기준 주소 (예: http://localhost:5173)
  --viewport <WxH>    뷰포트 너비x기본높이 (기본: 1440x900 — 높이는 캡처 시 문서 전체로 확장)
  --accent-color <c>  주석 색상 (기본: #FF3B30)
  --font <css>        주석 폰트 패밀리 (기본: 시스템 산세리프)
  --timeout <ms>      셀렉터·네트워크 대기 타임아웃 (기본: 15000)
  --headed            브라우저 창을 띄워서 실행 (디버그용)
  --quiet             진행 줄 생략 — 경고·에러와 마지막 판정 줄만 출력
  --help              이 도움말

마지막 줄에 CAPTURE: OK 또는 CAPTURE: FAIL — 사유 를 출력한다.`;

class SpecError extends Error {}

function parseArgs(argv) {
  const opts = {
    spec: null,
    all: null,
    out: 'captures',
    baseUrl: null,
    viewportWidth: 1440,
    viewportHeight: 900,
    accentColor: '#FF3B30',
    font: "-apple-system, 'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
    timeout: 15000,
    headed: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new SpecError(`${a} 뒤에 값이 필요합니다`);
      return argv[++i];
    };
    switch (a) {
      case '--spec': opts.spec = next(); break;
      case '--all': opts.all = next(); break;
      case '--out': opts.out = next(); break;
      case '--base-url': opts.baseUrl = next(); break;
      case '--viewport': {
        const m = /^(\d+)x(\d+)$/.exec(next());
        if (!m) throw new SpecError('--viewport 형식: 1440x900');
        opts.viewportWidth = Number(m[1]);
        opts.viewportHeight = Number(m[2]);
        break;
      }
      case '--accent-color': opts.accentColor = next(); break;
      case '--font': opts.font = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--headed': opts.headed = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new SpecError(`알 수 없는 옵션: ${a} (--help 참고)`);
    }
  }
  if (!opts.spec && !opts.all) throw new SpecError('--spec 또는 --all 이 필요합니다 (--help 참고)');
  if (opts.spec && opts.all) throw new SpecError('--spec 과 --all 은 동시에 쓸 수 없습니다');
  if (!opts.baseUrl) throw new SpecError('--base-url 이 필요합니다');
  return opts;
}

// 미매칭 API 감지용. Playwright glob 과 같은 규칙: ** 는 전부, * 는 / 제외 전부.
function patternToRegex(pattern, baseUrl) {
  let p = pattern;
  if (!/^(https?:)?\/\//.test(p) && !p.startsWith('*')) {
    p = baseUrl.replace(/\/$/, '') + (p.startsWith('/') ? '' : '/') + p;
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

async function runAction(page, action) {
  switch (action.type) {
    case 'click': {
      await page.locator(action.selector).first().click();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      break;
    }
    case 'fill':
      await page.locator(action.selector).first().fill(String(action.value ?? ''));
      break;
    case 'hover':
      await page.locator(action.selector).first().hover();
      break;
    case 'press':
      if (action.selector) await page.locator(action.selector).first().press(action.key);
      else await page.keyboard.press(action.key);
      break;
    case 'waitFor':
      await page.locator(action.selector).first().waitFor({ state: action.state ?? 'visible' });
      break;
    case 'wait':
      await page.waitForTimeout(action.ms ?? 500);
      break;
    default:
      throw new Error(`지원하지 않는 action type: "${action.type}"`);
  }
}

async function injectOverlay(page, spec, opts, warn) {
  const ann = spec.annotations ?? {};
  const groups = [
    ['badges', ann.badges ?? []],
    ['boxes', ann.boxes ?? []],
    ['zooms', ann.zooms ?? []],
  ];
  const tagged = { badges: [], boxes: [], zooms: [] };
  let seq = 0;

  // selector 가 요소를 못 찾으면 즉시 에러로 중단한다. 조용히 넘어가면 뱃지가
  // 엉뚱한 곳을 가리키게 되고, 그 오류는 사람 눈으로만 잡힌다.
  const tagElement = async (label, selector) => {
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count === 0) throw new SpecError(`${label}: selector 가 요소를 찾지 못함 — "${selector}"`);
    if (count > 1) warn(`${label}: "${selector}" 가 ${count}개 요소와 일치 — 첫 번째를 사용`);
    const first = loc.first();
    if (!(await first.boundingBox())) {
      throw new SpecError(`${label}: "${selector}" 요소가 보이지 않음(숨김 또는 크기 0) — 주석을 붙일 수 없음`);
    }
    const tag = String(seq++);
    await first.evaluate((el, t) => el.setAttribute('data-cap-ann', t), tag);
    return tag;
  };

  for (const [group, items] of groups) {
    for (const item of items) {
      const tag = await tagElement(`annotations.${group}`, item.selector);
      tagged[group].push({ ...item, tag });
    }
  }

  let clipTag = null;
  if (spec.clip?.selector) {
    clipTag = await tagElement('clip', spec.clip.selector);
  }

  const hasWork = tagged.badges.length || tagged.boxes.length || tagged.zooms.length || clipTag !== null;
  if (!hasWork) return null;

  const result = await page.evaluate(({ tagged, clipTag, accentColor, font }) => {
    const docW = window.innerWidth;
    const docH = window.innerHeight;
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    const rectOf = (tag) => {
      const el = document.querySelector(`[data-cap-ann="${tag}"]`);
      if (!el) throw new Error(`태그된 요소가 사라짐 (data-cap-ann=${tag})`);
      const r = el.getBoundingClientRect();
      return { el, x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
    };

    const overlay = document.createElement('div');
    overlay.id = '__cap-overlay__';
    overlay.style.cssText =
      `position:absolute;left:0;top:0;width:${docW}px;height:${docH}px;` +
      `z-index:2147483647;pointer-events:none;font-family:${font};`;
    document.body.appendChild(overlay);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(docW));
    svg.setAttribute('height', String(docH));
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
    overlay.appendChild(svg);

    const annRects = [];

    for (const b of tagged.boxes) {
      const r = rectOf(b.tag);
      const PAD = 4;
      const d = document.createElement('div');
      d.style.cssText =
        `position:absolute;left:${r.x - PAD}px;top:${r.y - PAD}px;` +
        `width:${r.w + PAD * 2}px;height:${r.h + PAD * 2}px;` +
        `border:2.5px solid ${accentColor};border-radius:6px;box-sizing:border-box;`;
      overlay.appendChild(d);
      annRects.push({ x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 });
    }

    const SIZE = 26;
    const GAP = 6;
    for (const b of tagged.badges) {
      const r = rectOf(b.tag);
      // 요소를 가리지 않도록 바깥 모서리 중 페이지 안에 들어가는 첫 후보를 고른다
      const candidates = [
        { x: r.x - SIZE - GAP, y: r.y - SIZE - GAP },
        { x: r.x + r.w + GAP, y: r.y - SIZE - GAP },
        { x: r.x - SIZE - GAP, y: r.y + r.h + GAP },
        { x: r.x + r.w + GAP, y: r.y + r.h + GAP },
      ];
      let pos = candidates.find(
        (c) => c.x >= 2 && c.y >= 2 && c.x + SIZE <= docW - 2 && c.y + SIZE <= docH - 2,
      );
      if (!pos) {
        pos = {
          x: clamp(r.x - SIZE / 2, 2, docW - SIZE - 2),
          y: clamp(r.y - SIZE / 2, 2, docH - SIZE - 2),
        };
      }
      const d = document.createElement('div');
      d.textContent = String(b.n);
      d.style.cssText =
        `position:absolute;left:${pos.x}px;top:${pos.y}px;width:${SIZE}px;height:${SIZE}px;` +
        `border-radius:50%;background:${accentColor};color:#fff;font-size:15px;font-weight:700;` +
        `line-height:${SIZE}px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);`;
      overlay.appendChild(d);
      annRects.push({ x: pos.x, y: pos.y, w: SIZE, h: SIZE });
      // 뱃지가 가리키는 요소가 clip 에서 잘리면 뱃지가 무의미해지므로 합집합에 포함
      annRects.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }

    for (const z of tagged.zooms) {
      const r = rectOf(z.tag);
      const factor = z.factor ?? 2.5;
      const sw = r.w * factor;
      const sh = r.h * factor;
      const M = 36;
      const EDGE = 8;
      // 배치 우선순위: 오른쪽 여백 → 왼쪽 여백 → 아래
      let x;
      let y;
      if (r.x + r.w + M + sw + EDGE <= docW) { x = r.x + r.w + M; y = r.y; }
      else if (r.x - M - sw >= EDGE) { x = r.x - M - sw; y = r.y; }
      else { x = clamp(r.x, EDGE, Math.max(EDGE, docW - sw - EDGE)); y = r.y + r.h + M; }
      y = clamp(y, EDGE, Math.max(EDGE, docH - sh - EDGE));

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(r.x + r.w / 2));
      line.setAttribute('y1', String(r.y + r.h / 2));
      line.setAttribute('x2', String(x + sw / 2));
      line.setAttribute('y2', String(y + sh / 2));
      line.setAttribute('stroke', accentColor);
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4');
      svg.appendChild(line);

      const ring = document.createElement('div');
      ring.style.cssText =
        `position:absolute;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.w + 6}px;height:${r.h + 6}px;` +
        `border:2px solid ${accentColor};border-radius:6px;box-sizing:border-box;`;
      overlay.appendChild(ring);

      const wrap = document.createElement('div');
      wrap.style.cssText =
        `position:absolute;left:${x}px;top:${y}px;width:${sw}px;height:${sh}px;` +
        `background:#fff;border:2px solid ${accentColor};border-radius:8px;overflow:hidden;` +
        `box-shadow:0 4px 16px rgba(0,0,0,.25);`;
      const inner = document.createElement('div');
      inner.style.cssText = `transform:scale(${factor});transform-origin:0 0;width:${r.w}px;height:${r.h}px;`;
      const clone = r.el.cloneNode(true);
      clone.style.margin = '0';
      // cloneNode 는 입력값 등 라이브 상태를 복사하지 않는다
      const src = [r.el, ...r.el.querySelectorAll('input,textarea,select')];
      const dst = [clone, ...clone.querySelectorAll('input,textarea,select')];
      src.forEach((s, i) => {
        if (dst[i] && 'value' in s && 'value' in dst[i]) dst[i].value = s.value;
      });
      inner.appendChild(clone);
      wrap.appendChild(inner);
      overlay.appendChild(wrap);
      annRects.push({ x, y, w: sw, h: sh });
    }

    let clip = null;
    if (clipTag !== null) {
      const c = rectOf(clipTag);
      let x1 = c.x;
      let y1 = c.y;
      let x2 = c.x + c.w;
      let y2 = c.y + c.h;
      // clip 영역 밖에 놓인 주석이 잘리지 않도록 합집합을 취한다
      for (const a of annRects) {
        x1 = Math.min(x1, a.x);
        y1 = Math.min(y1, a.y);
        x2 = Math.max(x2, a.x + a.w);
        y2 = Math.max(y2, a.y + a.h);
      }
      const PADC = 8;
      x1 = clamp(x1 - PADC, 0, docW);
      y1 = clamp(y1 - PADC, 0, docH);
      x2 = clamp(x2 + PADC, 0, docW);
      y2 = clamp(y2 + PADC, 0, docH);
      clip = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
    return { clip };
  }, { tagged, clipTag, accentColor: opts.accentColor, font: opts.font });

  return result.clip;
}

async function captureSpec(browser, specPath, opts) {
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    console.warn(`  ⚠ ${msg}`);
  };

  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  if (!spec.id || !spec.url) throw new SpecError(`명세에 id 와 url 은 필수입니다: ${specPath}`);

  let frozenMs = null;
  if (spec.freezeTime) {
    frozenMs = new Date(spec.freezeTime).getTime();
    if (Number.isNaN(frozenMs)) throw new SpecError(`freezeTime 을 해석할 수 없습니다: "${spec.freezeTime}"`);
  }

  const context = await browser.newContext({
    baseURL: opts.baseUrl,
    viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
    deviceScaleFactor: 2,
  });

  try {
    const cookies = spec.auth?.cookies ?? [];
    if (cookies.length) {
      await context.addCookies(cookies.map((c) => (c.url || c.domain ? c : { ...c, url: opts.baseUrl })));
    }

    // 페이지 스크립트보다 먼저 실행되어야 하므로 addInitScript 로 주입한다
    const storages = spec.auth?.storage ? [].concat(spec.auth.storage) : [];
    await context.addInitScript(({ storages, frozenMs }) => {
      for (const s of storages) {
        const store = s.type === 'sessionStorage' ? window.sessionStorage : window.localStorage;
        store.setItem(s.key, s.value);
      }
      if (frozenMs !== null) {
        const RealDate = Date;
        class FrozenDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(frozenMs);
            else super(...args);
          }
          static now() { return frozenMs; }
        }
        FrozenDate.parse = RealDate.parse;
        FrozenDate.UTC = RealDate.UTC;
        window.Date = FrozenDate;
      }
    }, { storages, frozenMs });

    const page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);

    const routes = spec.routes ?? [];
    // GraphQL 처럼 엔드포인트가 하나뿐인 API 는 URL 만으로 구분할 수 없으므로
    // 요청 본문의 operationName 으로 갈라준다 (없으면 기존대로 URL 만 본다)
    const opNameOf = (postData) => {
      if (!postData) return null;
      try {
        const b = JSON.parse(postData);
        return (Array.isArray(b) ? b[0]?.operationName : b?.operationName) ?? null;
      } catch { return null; }
    };
    // page.route 는 나중에 등록된 것부터 검사하므로 명세의 앞 항목이 우선하도록 역순 등록
    for (const r of [...routes].reverse()) {
      await page.route(r.pattern, (route, request) => {
        if (r.operationName) {
          const wanted = [].concat(r.operationName);
          if (!wanted.includes(opNameOf(request.postData()))) return route.fallback();
        }
        return route.fulfill({
          status: r.status ?? 200,
          contentType: r.contentType ?? 'application/json',
          headers: r.headers,
          body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null),
        });
      });
    }
    const routeRegexes = routes.map((r) => patternToRegex(r.pattern, opts.baseUrl));
    const declaredOps = new Set(routes.flatMap((r) => (r.operationName ? [].concat(r.operationName) : [])));
    const unmatched = new Set();
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      if (!routeRegexes.some((re) => re.test(req.url()))) {
        unmatched.add(`${req.method()} ${req.url()}`);
        return;
      }
      const op = opNameOf(req.postData());
      if (op && declaredOps.size && !declaredOps.has(op)) {
        unmatched.add(`GraphQL ${op} (${req.url()})`);
      }
    });

    await page.goto(spec.url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => warn('networkidle 대기 시간 초과 — 그대로 진행'));

    for (const [i, action] of (spec.actions ?? []).entries()) {
      try {
        await runAction(page, action);
      } catch (e) {
        throw new SpecError(`actions[${i}] (${action.type}${action.selector ? ` ${action.selector}` : ''}) 실패: ${e.message}`);
      }
    }

    for (const sel of spec.hide ?? []) {
      const loc = page.locator(sel);
      if ((await loc.count()) === 0) {
        warn(`hide: "${sel}" 와 일치하는 요소 없음 — 건너뜀`);
        continue;
      }
      await loc.evaluateAll((els) => els.forEach((el) => el.style.setProperty('visibility', 'hidden', 'important')));
    }

    const textLen = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, '').length);
    if (textLen < 30) warn(`본문 텍스트가 거의 없습니다 (${textLen}자) — 빈 화면이거나 렌더링 실패일 수 있음`);

    // fullPage 스크린샷은 스크롤·스티칭 과정에서 좌표가 어긋나므로 쓰지 않고,
    // 뷰포트 자체를 문서 전체 높이로 키운다
    const docHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await page.setViewportSize({
      width: opts.viewportWidth,
      height: Math.max(opts.viewportHeight, docHeight),
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    // 리사이즈로 인한 리플로우가 끝난 뒤에 주석 좌표를 계산해야 한다
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const clipRect = await injectOverlay(page, spec, opts, warn);

    const outPath = path.join(opts.out, `${spec.id}.png`);
    await page.screenshot({
      path: outPath,
      animations: 'disabled',
      caret: 'hide',
      ...(clipRect ? { clip: clipRect } : {}),
    });

    if (unmatched.size) {
      warn(`route 와 매칭되지 않은 API 호출 ${unmatched.size}건 — 명세에 빠진 엔드포인트일 수 있음:`);
      for (const u of unmatched) console.warn(`      · ${u}`);
    }

    return { id: spec.id, outPath, warnings };
  } finally {
    await context.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright 를 찾을 수 없습니다. 이 디렉토리에서 먼저 실행하세요:');
    console.error('  npm install && npx playwright install chromium');
    console.log('CAPTURE: FAIL — playwright 미설치');
    process.exit(1);
  }

  let specFiles;
  if (opts.all) {
    specFiles = (await readdir(opts.all))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(opts.all, f));
    if (specFiles.length === 0) throw new SpecError(`${opts.all} 에 *.json 명세가 없습니다`);
  } else {
    specFiles = [opts.spec];
  }

  await mkdir(opts.out, { recursive: true });
  const browser = await chromium.launch({ headless: !opts.headed });
  const failed = [];
  let warned = 0;

  try {
    for (const file of specFiles) {
      if (!opts.quiet) console.log(`▶ ${file}`);
      try {
        const { id, outPath, warnings } = await captureSpec(browser, file, opts);
        warned += warnings.length;
        if (!opts.quiet) console.log(`  ✔ ${id} → ${outPath}`);
      } catch (e) {
        const msg = e instanceof SpecError ? e.message : (e?.message ?? String(e));
        console.error(`  ✘ 실패: ${msg}`);
        failed.push({ file, msg });
      }
    }
  } finally {
    await browser.close();
  }

  if (failed.length) {
    const reason = opts.all
      ? `${failed.length}/${specFiles.length} 실패: ${failed.map((f) => path.basename(f.file)).join(', ')}`
      : failed[0].msg;
    console.log(`CAPTURE: FAIL — ${reason}`);
    process.exit(1);
  }
  console.log(`CAPTURE: OK${warned ? ` (경고 ${warned}건)` : ''}`);
}

main().catch((e) => {
  const msg = e instanceof SpecError ? e.message : (e?.stack ?? String(e));
  console.error(msg);
  console.log(`CAPTURE: FAIL — ${e?.message ?? e}`);
  process.exit(1);
});
