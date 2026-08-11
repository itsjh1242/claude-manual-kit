// template.typ — 사용 설명서 PDF 템플릿 (Typst 0.15.x 에서 검증)
// build.mjs 가 생성한 main.typ 이 이 파일을 import 한다.

// ═══════════════════════════════════════════════════════════════
// 사용자 설정 — 색상·글꼴은 여기만 고치면 됩니다
// ═══════════════════════════════════════════════════════════════
#let cfg = (
  // 한글 폰트 후보 — 앞에서부터 시스템에 있는 것을 사용
  fonts: ("Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", "Pretendard", "NanumGothic"),
  font-size: 10.5pt,

  accent: rgb("#2563eb"),        // 표지·기능 제목·상호 참조
  badge: rgb("#ff3b30"),         // "화면 구성" 번호 원 — 캡처 뱃지와 같은 색으로 맞출 것
  note-color: rgb("#2563eb"),    // 참고 상자
  warn-color: rgb("#d97706"),    // 주의 상자
  result-color: rgb("#16a34a"),  // 결과 상자
  text-color: rgb("#1f2937"),
  muted: rgb("#6b7280"),

  margin: (x: 20mm, y: 22mm),
)

// ═══════════════════════════════════════════════════════════════
// 내부 구성 요소
// ═══════════════════════════════════════════════════════════════

// 정보 상자 3종: 참고 / 주의 / 결과
#let infobox(kind, body) = {
  let styles = (
    note: ("참고", cfg.note-color, "ℹ"),
    warn: ("주의", cfg.warn-color, "⚠"),
    result: ("결과", cfg.result-color, "✓"),
  )
  let (label-text, color, icon) = styles.at(kind)
  block(
    breakable: false,
    width: 100%,
    inset: 11pt,
    radius: 4pt,
    fill: color.lighten(93%),
    stroke: (left: 3pt + color),
    above: 1em,
    below: 1em,
  )[
    #text(fill: color, weight: "bold", size: 0.9em)[#icon #label-text]
    #v(3pt)
    #body
  ]
}

#let note(body) = infobox("note", body)
#let warnbox(body) = infobox("warn", body)
#let resultbox(body) = infobox("result", body)

// 캡처 뱃지와 짝을 이루는 번호 원
#let badge(n) = box(
  baseline: 28%,
  circle(
    fill: cfg.badge,
    radius: 0.62em,
    align(center + horizon, text(fill: white, weight: "bold", size: 0.72em, str(n))),
  ),
)

// "화면 구성" 목록 — 번호를 뱃지 모양으로
#let screen-list(body) = {
  set enum(numbering: n => badge(n), spacing: 1em, indent: 0pt, body-indent: 0.7em)
  body
}

// 캡처 이미지 — 폭·최소 크기 검증은 build.mjs 가 하고 width 를 계산해 넘긴다
#let screenshot(path, width: 100%, caption: none) = {
  block(breakable: false, width: 100%, above: 1em, below: 1em)[
    #align(center)[
      #box(
        stroke: 0.5pt + cfg.muted.lighten(40%),
        radius: 4pt,
        clip: true,
        image(path, width: width),
      )
    ]
    #if caption != none [
      #align(center, text(size: 0.85em, fill: cfg.muted, caption))
    ]
  ]
}

// 기능 하나. n 은 build.mjs 가 파일 순서로 부여한다
#let feature(n, title, body) = {
  [#heading(level: 1)[기능 #n. #title] #label("feat-" + str(n))]
  body
}

// 상호 참조 — 대상 기능의 실제 페이지로 링크
#let featref(n) = context {
  let l = label("feat-" + str(n))
  let loc = locate(l)
  link(loc, text(fill: cfg.accent, weight: "medium")[→ 기능 #n 참고 (#counter(page).at(loc).first()쪽)])
}

// ═══════════════════════════════════════════════════════════════
// 문서 전체 레이아웃
// ═══════════════════════════════════════════════════════════════
#let manual(
  title: "사용 설명서",
  subtitle: none,
  product: none,
  version: none,
  date: none,
  author: none,
  body,
) = {
  set document(title: title)
  set text(font: cfg.fonts, size: cfg.font-size, fill: cfg.text-color, lang: "ko")
  set page(paper: "a4", margin: cfg.margin)
  set par(justify: true, leading: 0.78em, spacing: 1.1em)
  set enum(indent: 0pt, body-indent: 0.6em, spacing: 0.7em)
  set list(indent: 0pt, body-indent: 0.6em, spacing: 0.7em)

  // 제목이 다음 내용과 페이지 경계에서 갈라지지 않게
  show heading: set block(sticky: true)
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(sticky: true, below: 1.2em)[
      #text(size: 1.55em, weight: "bold", fill: cfg.accent, it.body)
      #v(2pt)
      #line(length: 100%, stroke: 1.5pt + cfg.accent.lighten(60%))
    ]
  }
  show heading.where(level: 2): it => block(
    sticky: true, above: 1.4em, below: 0.7em,
    text(size: 1.1em, weight: "bold", it.body),
  )

  // ── 표지 ──
  page(footer: none)[
    #v(28%)
    #if product != none [
      #text(size: 1.1em, fill: cfg.muted, product)
      #v(6pt)
    ]
    #text(size: 2.4em, weight: "bold", fill: cfg.accent, title)
    #if subtitle != none [
      #v(8pt)
      #text(size: 1.3em, fill: cfg.text-color, subtitle)
    ]
    #v(1fr)
    #line(length: 100%, stroke: 0.5pt + cfg.muted.lighten(40%))
    #v(6pt)
    #text(size: 0.9em, fill: cfg.muted)[
      #(
        (version, date, author)
          .filter(v => v != none)
          .join("  ·  ")
      )
    ]
    #v(10%)
  ]

  // ── 본문 이후: 각 페이지 하단에 문서명 + 페이지 번호 ──
  set page(
    footer: context [
      #text(size: 0.8em, fill: cfg.muted)[
        #title
        #h(1fr)
        #counter(page).display("1")
      ]
    ],
  )
  counter(page).update(1)

  // ── 목차 ──
  {
    show outline.entry: set block(above: 0.9em)
    outline(title: [목차], depth: 1)
  }

  // ── 본문 ──
  body

  // ── 뒷표지 ──
  pagebreak(weak: true)
  page(footer: none)[
    #v(1fr)
    #align(center)[
      #line(length: 30%, stroke: 0.5pt + cfg.muted.lighten(40%))
      #v(10pt)
      #text(fill: cfg.muted, size: 0.95em)[
        #if product != none [#product — ] #title
        #if version != none [ #version]
      ]
      #if date != none [
        #v(4pt)
        #text(fill: cfg.muted, size: 0.85em, date)
      ]
    ]
    #v(1fr)
  ]
}
