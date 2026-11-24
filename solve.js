// site-generator-speed-01 v2 — a faster drop-in for makefun-site 1.0.0.
//
// Written fresh from the competition spec (README.md of makefun-site 1.0.0) and the
// reference pipeline's observable behaviour. It returns, for every case input, the
// exact output tree makefun-site 1.0.0's build returns, byte for byte.
//
// Where the speed comes from (no behaviour change, only less work):
//  - Markdown is rendered in one fused pass: no lex token array, no per-character
//    escape calls. Inline text is scanned once; runs of plain text are appended
//    untouched and only the characters that need escaping are ever touched.
//  - Front matter is parsed by scanning lines in place; the body is a slice, never
//    a split-and-rejoin of the whole source.
//  - Slugs are memoised per build and take a fast ASCII path (NFKD is the identity
//    on ASCII, and ASCII carries no combining marks).
//  - Word counting scans character codes instead of building a match array.
//  - Templates keep the reference node tree, but rendering pushes into one array,
//    reuses each for-loop's scope frame, and never allocates a scope per element.
//  - Link targets are resolved once per source and cached there.
//
// Deterministic: no clock, no randomness, no environment, no I/O. One case's
// answer depends only on that case's input; the slug memo is reset per run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SLUG_MAX = 64;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `text` with & < > " and ' escaped. Clean strings come back untouched. */
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_REPLACE, (c) => ESCAPES[c]);
}

/** The slug memo for the build in progress; reset at the top of every run(). */
let slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  if (ascii) {
    // NFKD is the identity on ASCII and ASCII carries no combining marks, so the
    // slow path below would do exactly this. One pass over char codes.
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is JavaScript whitespace (the whole \s set, exactly). */
function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. No array built. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII whitespace is 9-13 and 32; any other whitespace is above 127.
    const w = c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWS(c));
    if (w) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Spaces and tabs at either end dropped (nothing else: this is not trim()). */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * The line starting at `pos` in `s`: [line, nextPos], or null past the end.
 * Lines are slices (no copy); the last line needs no trailing newline.
 */
function lineAt(s, pos) {
  if (pos > s.length) return null;
  const e = s.indexOf('\n', pos);
  if (e === -1) return [s.slice(pos), s.length + 1];
  return [s.slice(pos, e), e + 1];
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The body is a slice of `text`,
 * never a split-and-rejoin: only the short front-matter region is walked line
 * by line, and only until its closing `---`.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing `---` (line index closeIdx, its line end closeEnd).
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let idx = 1;
  let closeIdx = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const ln = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (ln === '---') { closeIdx = idx; closeEnd = e; break; }
    if (e === -1) break;
    pos = e + 1;
    idx++;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = firstNl === -1 ? text.length : firstNl + 1;
  for (let i = 1; i < closeIdx; i++) {
    const e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    if (FM_BLANK.test(line) || line.startsWith('#')) {
      if (e === -1) break;
      p = e + 1;
      continue;
    }
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    if (e === -1) break;
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_WS = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return MD_BLANK.test(line) || MD_FENCE_OPEN.test(line) || headingOf(line) !== null || MD_HR.test(line);
}

/** The next inline-significant character: backslash, backtick, *, [, or one of & < > " '. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;
const SPECIAL_TEST = /[\\`*\[&<>"']/;

/**
 * Whether the character at `k` is escaped by the scan from `from`: the scan
 * consumes backslash pairs left to right, so a character is escaped exactly
 * when the run of backslashes immediately before it (counted from `from`) is
 * odd. The target characters here ('*', ']') are themselves escapable, which
 * is what makes the parity rule exact.
 */
function isEscapedAt(s, k, from) {
  let r = 0;
  for (let j = k - 1; j >= from && s[j] === '\\'; j--) r++;
  return (r & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let p = from;
  while (true) {
    const k = s.indexOf(what, p);
    if (k === -1) return -1;
    if (isEscapedAt(s, k, from)) { p = k + 1; continue; }
    return k;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let p = from;
  while (true) {
    const k = s.indexOf('*', p);
    if (k === -1) return -1;
    if (isEscapedAt(s, k, from)) { p = k + 1; continue; }
    if (s[k + 1] === '*') { p = k + 2; continue; }
    return k;
  }
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One native scan
 * finds the next significant character; runs of plain text (no escapable or
 * markup character in them by construction) are appended untouched, and a
 * string with no significant character at all is returned as it stands.
 * SPECIAL_RE's lastIndex is set before every exec, so the nested inline calls
 * for strong, emphasis and link text cannot disturb the outer scan.
 */
function inline(s, env) {
  if (!SPECIAL_TEST.test(s)) return s;
  const out = [];
  let i = 0;
  const len = s.length;
  while (true) {
    SPECIAL_RE.lastIndex = i;
    const hit = SPECIAL_RE.exec(s);
    if (hit === null) {
      if (i < len) out.push(s.slice(i));
      break;
    }
    const j = hit.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s.charCodeAt(j);
    if (c === 38) { out.push('&amp;'); i = j + 1; continue; }
    if (c === 60) { out.push('&lt;'); i = j + 1; continue; }
    if (c === 62) { out.push('&gt;'); i = j + 1; continue; }
    if (c === 34) { out.push('&quot;'); i = j + 1; continue; }
    if (c === 39) { out.push('&#39;'); i = j + 1; continue; }
    if (c === 92) {
      if (j + 1 < len && ESCAPABLE.has(s[j + 1])) { out.push(escapeHtml(s[j + 1])); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>'); i = k + 1; }
      else { out.push('`'); i = j + 1; }
      continue;
    }
    if (c === 42) {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>'); i = k + 2; }
        else { out.push('**'); i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out.push('<em>', inline(s.slice(j + 1, k), env), '</em>'); i = k + 1; }
        else { out.push('*'); i = j + 1; }
      }
      continue;
    }
    // '[': a link, or a literal '['.
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !MD_WS.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
      i = m + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
  return out.join('');
}

/**
 * `src` rendered in one fused pass (no lex token array): its HTML (each block on
 * its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;
  while (true) {
    const cur = lineAt(src, pos);
    if (cur === null) break;
    const line = cur[0];
    let next = cur[1];
    if (MD_BLANK.test(line)) { pos = next; continue; }
    const fence = MD_FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      pos = next;
      while (true) {
        const l2 = lineAt(src, pos);
        if (l2 === null) { pos = src.length + 1; break; }
        if (MD_FENCE_CLOSE.test(l2[0])) { pos = l2[1]; break; }
        body.push(l2[0]);
        pos = l2[1];
      }
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`)}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      pos = next;
      continue;
    }
    if (MD_HR.test(line)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (true) {
        const l2 = lineAt(src, pos);
        if (l2 === null || l2[0].charCodeAt(0) !== 62) break;
        const l = l2[0];
        qlines.push(trimST(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        pos = l2[1];
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (true) {
        const l2 = lineAt(src, pos);
        if (l2 === null) break;
        const m = marker.exec(l2[0]);
        if (m !== null) {
          items.push([trimST(isOrdered ? m[2] : m[1])]);
          pos = l2[1];
        } else if (MD_CONTINUED.test(l2[0])) {
          items[items.length - 1].push(trimST(l2[0]));
          pos = l2[1];
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const para = [trimST(line)];
    pos = next;
    while (true) {
      const l2 = lineAt(src, pos);
      if (l2 === null) break;
      if (endsParagraph(l2[0])) break;
      para.push(trimST(l2[0]));
      pos = l2[1];
    }
    const html = inline(para.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TPL_SPACES = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TPL_SPACES.test(src.slice(lineStart, open)) && TPL_SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (one array per render, joined once at the end).
 * A for-loop reuses one scope frame for all its elements: rendering is
 * synchronous and depth-first, so mutating the frame per element is invisible
 * to the output. The one exception is `{% for loop in ... %}`: there the
 * reference binds `loop` to the loop record itself, never to the element, so
 * the element is left unassigned on purpose, exactly as the reference does.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { [n.name]: undefined, loop };
        const frame = { vars, parent: scope };
        const bindsElement = n.name !== 'loop';
        for (let k = 0; k < xs.length; k++) {
          if (bindsElement) vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, frame, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePathParts(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const cache = new Map();
    const link = (target) => {
      const cached = cache.get(target);
      if (cached !== undefined) return cached;
      let href;
      if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) href = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePathParts(dirParts, rel);
        if (path !== null && b.bySource.has(path)) href = `${b.bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${b.base}/${path}${frag}`;
        else {
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          href = target;
        }
      }
      cache.set(target, href);
      return href;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it. Built once per source and reused by the
  // page itself and by every list that shows it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of b.sources) s.card = cardOf(s);

  // A tag as templates read it (its posts as cards).
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugCache = new Map();
  return build(input);
}
