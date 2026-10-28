// @ts-check
// Selection affects one prompt only. Storage and the caller's entries remain untouched.
import { neutralizeMarks } from './relay-guard.mjs';

export const MEMORY_CONTEXT_MAX = 6000;

function queryTerms(query) {
  const words = String(query).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = new Set(words);
  for (const word of words) {
    for (const run of word.match(/\p{Script=Han}+/gu) ?? []) {
      const chars = [...run];
      if (chars.length === 1) terms.add(run);
      for (let index = 0; index + 1 < chars.length; index += 1) terms.add(chars[index] + chars[index + 1]);
    }
  }
  return [...terms];
}

function relevance(entry, terms) {
  const text = String(entry.text).normalize('NFKC').toLowerCase();
  const key = String(entry.key ?? '').normalize('NFKC').toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0) + (key.includes(term) ? 3 : 0), 0);
}

function serializeEntry(entry) {
  return JSON.stringify({
    scope: entry.scope, id: entry.id, key: entry.key ?? '', revision: entry.revision ?? '',
    pinned: Boolean(entry.pinned),
    // A memory entry is written by a Bot (or by the user) and travels into the memory block of
    // every Bot that reads it. A protocol mark in it would close that block early, so the marks
    // go the way they go in a reply: out of the text, the words around them untouched.
    text: neutralizeMarks(String(entry.text ?? '')),
  });
}

/**
 * A shared self/team budget, including every marker, encoded value and separator.
 * Whole records that do not fit are skipped so smaller useful records can still fit.
 */
export function selectMemoryContext(scopedEntries, { query = '', limit = MEMORY_CONTEXT_MAX } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Memory context limit must be a non-negative integer');
  const terms = queryTerms(query);
  const candidates = scopedEntries.map((entry, index) => ({
    entry, index, score: relevance(entry, terms), added: Date.parse(entry.added ?? '') || 0,
  })).sort((a, b) => Number(Boolean(b.entry.pinned)) - Number(Boolean(a.entry.pinned)) ||
    b.score - a.score || b.added - a.added || b.index - a.index);
  const entries = [];
  const lines = [];
  let used = 0;
  for (const { entry } of candidates) {
    const line = serializeEntry(entry);
    const size = line.length + (lines.length ? 1 : 0);
    if (used + size > limit) continue;
    entries.push(entry);
    lines.push(line);
    used += size;
  }
  return { entries, text: lines.join('\n'), used, limit, total: scopedEntries.length, omitted: scopedEntries.length - entries.length };
}
