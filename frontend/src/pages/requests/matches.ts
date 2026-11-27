import type { GuardrailHit } from "../../lib/api";

/** Finding the words a content rule matched inside the stored prompt, so the inspector can show the admin the
 *  sentence with those words highlighted.
 *
 *  The server keeps the matched words (word and phrase rules only; a pattern or a card/key/email detector keeps
 *  none) and a few characters of context with "[matched]" where they were. The engine matched case-insensitively
 *  (and, for whole-word rules, only on word boundaries), so the same rules are applied here to the stored prompt.
 *  Everything here is a display aid: when a word cannot be found in the prompt the caller falls back to the
 *  server's own context, which is always exact. */

/** [start, end) positions in a text. */
export type Range = readonly [start: number, end: number];

/** A matched word or phrase, as the server kept it. */
export interface MatchedWords {
  text: string;
  /** The first match sat inside a longer word, so the rule matches inside words and the others may too. For a
   *  whole-word rule (the usual case) this is false and only whole words are highlighted. */
  inWord: boolean;
}

/** A piece of the prompt, labelled by who wrote it (system, user, ...). */
export interface PromptPart {
  label: string;
  text: string;
}

/** One sentence of the prompt, split around the highlighted words. */
export interface Sentence {
  before: string;
  match: string;
  after: string;
}

const MARK = "[matched]";
const ELLIPSIS = "…";
const MAX_RANGES = 200; // a page of highlights is plenty, and keeps a pathological prompt from building a huge DOM

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = (c: string | undefined) => !!c && WORD_CHAR.test(c);

function sitsInsideWord(snippet: string | null | undefined): boolean {
  const at = snippet ? snippet.indexOf(MARK) : -1;
  if (!snippet || at < 0) return false;
  return isWordChar(snippet.slice(0, at).slice(-1)) || isWordChar(snippet.slice(at + MARK.length).charAt(0));
}

/** The words each word/phrase hit matched (none for pattern and detector hits), without repeats. */
export function matchedWords(hits: readonly GuardrailHit[]): MatchedWords[] {
  const seen = new Set<string>();
  const out: MatchedWords[] = [];
  for (const h of hits) {
    let text = (h.matched_text ?? "").trim();
    if (!text) continue;
    // A long phrase is kept cut short with an ellipsis: look for its beginning, and do not insist on a word boundary.
    const cut = text.endsWith(ELLIPSIS);
    if (cut) text = text.slice(0, -ELLIPSIS.length).trimEnd();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, inWord: cut || sitsInsideWord(h.snippet) });
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words as a regex that ignores case and lets any run of whitespace (a newline, two spaces) stand for a space. */
function matcher(words: string): RegExp | null {
  const tokens = words.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  try {
    return new RegExp(tokens.map(escape).join("\\s+"), "giu");
  } catch {
    return null;
  }
}

/** Where `words` occur in `text`, in reading order, overlaps merged. */
export function findRanges(text: string, words: readonly MatchedWords[], max = MAX_RANGES): Range[] {
  const found: [number, number][] = [];
  for (const w of words) {
    const re = matcher(w.text);
    if (!re) continue;
    let m: RegExpExecArray | null;
    while (found.length < max && (m = re.exec(text))) {
      const a = m.index;
      const b = a + m[0].length;
      if (w.inWord || (!isWordChar(text[a - 1]) && !isWordChar(text[b]))) found.push([a, b]);
    }
  }
  found.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const SPACE = /\s/;
const REACH = 110; // characters of the sentence shown either side of the words before it is cut at a word

/** A full stop, ? or ! that ends a sentence (followed by a space or the end, so "3.5" does not), or a Chinese/Japanese
 *  one, which is not followed by a space. */
function endsSentence(text: string, i: number): boolean {
  const c = text[i];
  if (c === "。" || c === "！" || c === "？") return true;
  return (c === "." || c === "!" || c === "?") && (i + 1 >= text.length || SPACE.test(text[i + 1]));
}

/** The sentence that holds `range`: from the end of the one before (or a line break) to its own end. A very long
 *  sentence is cut at a word, with an ellipsis, so the words stay in view. */
export function sentenceAround(text: string, range: Range, reach = REACH): Sentence {
  const [a, b] = range;
  let s = 0;
  for (let i = a - 1; i >= 0; i--) {
    if (text[i] === "\n" || text[i] === "\r" || endsSentence(text, i)) {
      s = i + 1;
      break;
    }
  }
  while (s < a && SPACE.test(text[s])) s++;
  let e = text.length;
  for (let j = b; j < text.length; j++) {
    if (text[j] === "\n" || text[j] === "\r") {
      e = j;
      break;
    }
    if (endsSentence(text, j)) {
      e = j + 1;
      break;
    }
  }
  let cutStart = false;
  let cutEnd = false;
  if (a - s > reach) {
    let k = a - reach;
    while (k < a && !SPACE.test(text[k - 1])) k++;
    s = k < a ? k : a - reach;
    cutStart = true;
  }
  if (e - b > reach) {
    let k = b + reach;
    while (k > b && !SPACE.test(text[k])) k--;
    e = k > b ? k : b + reach;
    cutEnd = true;
  }
  const flat = (t: string) => t.replace(/\s+/g, " ");
  return {
    before: (cutStart ? ELLIPSIS : "") + flat(text.slice(s, a)),
    match: flat(text.slice(a, b)),
    after: flat(text.slice(b, e)).trimEnd() + (cutEnd ? ELLIPSIS : ""),
  };
}

/** The sentence the first match of this hit sits in, taken from the stored prompt; null when the hit kept no words (a
 *  pattern or detector) or they cannot be found in the prompt (the caller shows the server's context instead). */
export function sentenceForHit(hit: GuardrailHit, parts: readonly PromptPart[]): Sentence | null {
  const words = matchedWords([hit]);
  if (!words.length) return null;
  // the part the rule engine found it in first, then the others
  const ordered = [...parts.filter((p) => p.label === hit.source_role), ...parts.filter((p) => p.label !== hit.source_role)];
  for (const p of ordered) {
    const first = findRanges(p.text, words, 1)[0];
    if (first) return sentenceAround(p.text, first);
  }
  return null;
}
