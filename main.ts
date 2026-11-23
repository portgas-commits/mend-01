// mend: one patch tool for every AI edit format. SPEC.md is the whole contract.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names even when the model drifted
// their whitespace or indentation, and changes every file or none.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serialize(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- matching (section 5)

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, 1, 2; only 0 when strict) at which O occurs at least once, from `from` on. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): Found | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const occ = occurrences(lines, o, tier).filter((p) => p >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function findTier(lines: string[], o: string[], strict: boolean): Found | null {
  return findTierFrom(lines, o, 0, strict);
}

/** First line at or after `from` equal to `anchor` (a single line), at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

/** A line of N: a context line is the file's own matched line; any other line is
 *  re-indented at tier 2 (section 5), written as it is at tiers 0 and 1. */
interface NEntry {
  text: string;
  oIdx: number | null;
}

function buildNew(nEntries: NEntry[], fileLines: string[], start: number, oFirst: string, tier: number): string[] {
  const f = tier === 2 ? leadWs(fileLines[start] ?? '') : '';
  const p = tier === 2 ? leadWs(oFirst) : '';
  return nEntries.map((e) => {
    if (e.oIdx !== null) return fileLines[start + e.oIdx]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || e.text.trim() === '') return e.text;
    if (p !== '' && !e.text.startsWith(p)) return e.text;
    return f + e.text.slice(p.length);
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  o: string[];
  n: NEntry[];
  plus: string[];
  bsAfterLastCtxPlus: boolean;
  bsAfterLastPlus: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to
 *  the first tab, with surrounding spaces removed; a leading a/ or b/ removed;
 *  /dev/null means no file. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t === '/dev/null' ? null : t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Parse one hunk starting at lines[i] (a `@@` line); return it and the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  let j = i + 1;
  const raw: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k]!;
    if (r === '' || r[0] === ' ' || r[0] === '+') lastCtxPlus = k;
    if (r[0] === '+') lastPlus = k;
  }
  const bsAfterLastCtxPlus = lastCtxPlus >= 0 && raw[lastCtxPlus + 1] !== undefined && raw[lastCtxPlus + 1]!.startsWith('\\');
  const bsAfterLastPlus = lastPlus >= 0 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.startsWith('\\');
  const o: string[] = [];
  const n: NEntry[] = [];
  const plus: string[] = [];
  for (const r of raw) {
    if (r === '' || r[0] === ' ') {
      const text = r === '' ? '' : r.slice(1);
      o.push(text);
      n.push({ text, oIdx: o.length - 1 });
    } else if (r[0] === '-') {
      o.push(r.slice(1));
    } else if (r[0] === '+') {
      const text = r.slice(1);
      n.push({ text, oIdx: null });
      plus.push(text);
    }
    // a `\` line refers to the body line before it; it carries no other meaning here
  }
  return { hunk: { a, o, n, plus, bsAfterLastCtxPlus, bsAfterLastPlus }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const newSection = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      isNew: false,
      isDel: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    hasPair = false;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!.trim();
      s.diffNew = m[2]!.trim();
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
      } else {
        const s = newSection();
        s.pairOld = headerPath(l);
        s.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.pairNew = headerPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isNew = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDel = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply one hunk to a file's lines; d is the drift of the hunks applied so far. */
function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): { st: FileState; d: number } {
  const lines = st.lines;
  if (h.o.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, lines.length));
    const nl = [...lines.slice(0, pos), ...h.n.map((e) => e.text), ...lines.slice(pos)];
    let final = st.final;
    if (pos === lines.length) final = !h.bsAfterLastCtxPlus;
    return { st: { lines: nl, br: st.br, final }, d: d + h.n.length };
  }
  const found = findTier(lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const start = best;
  const repl = buildNew(h.n, lines, start, h.o[0]!, found.tier);
  const nl = [...lines.slice(0, start), ...repl, ...lines.slice(start + h.o.length)];
  let final = st.final;
  if (start + h.o.length === lines.length) final = !h.bsAfterLastCtxPlus;
  return { st: { lines: nl, br: st.br, final }, d: d + (h.n.length - h.o.length) };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.diffOld ?? null);
  const newP = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.diffNew ?? null);
  const isCreate = oldP === null || s.isNew;
  const isDelete = !isCreate && (newP === null || s.isDel);
  if (isCreate) {
    return (tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) plus.push(...h.plus);
      let final = false;
      if (plus.length > 0) {
        for (let k = s.hunks.length - 1; k >= 0; k--) {
          if (s.hunks[k]!.plus.length > 0) {
            final = !s.hunks[k]!.bsAfterLastPlus;
            break;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (oldP === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  return (tree) => {
    const op = oldP as string;
    const np = newP as string;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    let st = parseText(cur);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(st, h, d, strict, op);
      st = r.st;
      d = r.d;
    }
    const text = serialize(st);
    if (op === np) {
      tree.now.set(op, text);
    } else {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push({ old: op, next: np });
    }
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let k = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        k = j;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE' || l.trimEnd() === '<<<<<<< SEARCH') break;
    }
    let m = -1;
    if (k >= 0) {
      for (let j = k + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trimEnd() === '>>>>>>> REPLACE') {
          m = j;
          break;
        }
        if (l.trimEnd() === '<<<<<<< SEARCH') break;
      }
    }
    if (k < 0 || m < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, k), newLines: lines.slice(k + 1, m) });
    prevEnd = m + 1;
    i = m + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const st = parseText(cur);
    const found = findTier(st.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const start = found.occ[0]!;
    const repl = buildNew(
      b.newLines.map((t) => ({ text: t, oIdx: null })),
      st.lines,
      start,
      b.oldLines[0]!,
      found.tier,
    );
    st.lines.splice(start, b.oldLines.length, ...repl);
    tree.now.set(b.path, serialize(st));
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NEntry[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

const blankish = (l: string): boolean => l.trim() === '';

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const raw: string[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isV4aSectionStart(m)) break;
        if (m.startsWith('+')) {
          raw.push(m.slice(1));
          i++;
          continue;
        }
        if (blankish(m)) {
          let j = i + 1;
          while (j < last && blankish(lines[j]!)) j++;
          if (j >= last || isV4aSectionStart(lines[j]!)) {
            i = j;
            continue;
          }
          raw.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'add', path, line: i, moveTo: null, lines: raw, chunks: [] });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isV4aSectionStart(m)) break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path, line: i, moveTo: null, lines: [], chunks: [] });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkStarted = false;
      const closeChunk = (eof: boolean): void => {
        if (cur !== null) {
          cur.eof = eof;
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const m = lines[i]!;
        if (isV4aSectionStart(m)) break;
        if (m.startsWith('@@')) {
          closeChunk(false);
          const anchor = m.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          chunkStarted = true;
          i++;
          continue;
        }
        if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          closeChunk(true);
          i++;
          continue;
        }
        if (m === '' || blankish(m) || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
          if (blankish(m)) {
            let j = i + 1;
            while (j < last && blankish(lines[j]!)) j++;
            if (j >= last || isV4aSectionStart(lines[j]!)) {
              i = j;
              continue;
            }
            if (cur === null && chunkStarted) {
              i++;
              continue;
            }
          }
          if (cur === null) {
            if (chunkStarted) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunkStarted = true;
          }
          if (m[0] === '-') {
            cur.o.push(m.slice(1));
          } else if (m[0] === '+') {
            cur.n.push({ text: m.slice(1), oIdx: null });
          } else {
            const text = m === '' ? '' : m.slice(1);
            cur.o.push(text);
            cur.n.push({ text, oIdx: cur.o.length - 1 });
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(false);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, line: updateLine, moveTo, lines: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vEdit(s, strict));
}

function vEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let st = parseText(cur);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(st.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        const repl = ch.n.map((e) => e.text);
        st.lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
        continue;
      }
      const found = findTierFrom(st.lines, ch.o, cursor, strict);
      if (found === null) throw new Fail('no-match', s.path);
      let start = found.occ[0]!;
      if (ch.eof) {
        const good = found.occ.filter((p) => p + ch.o.length === st.lines.length);
        if (good.length === 0) throw new Fail('no-match', s.path);
        start = good[0]!;
      }
      const repl = buildNew(ch.n, st.lines, start, ch.o[0]!, found.tier);
      st.lines.splice(start, ch.o.length, ...repl);
      cursor = start + repl.length;
    }
    const text = serialize(st);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push({ old: s.path, next: s.moveTo });
    } else {
      tree.now.set(s.path, text);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = parseText(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- run (sections 1, 2, 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.next);
    const nowOld = tree.get(mv.old);
    const nowNew = tree.get(mv.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.next, line: `R ${mv.old} -> ${mv.next}` });
      consumed.add(mv.old);
      consumed.add(mv.next);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
