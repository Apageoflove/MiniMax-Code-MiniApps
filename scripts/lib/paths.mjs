import path from 'node:path';

import { LIMITS, PORTABLE_SEGMENT, WINDOWS_RESERVED } from './contract.mjs';

export function normalizePluginPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\')) {
    return { ok: false, reason: 'must be a plugin-relative path' };
  }
  const withoutDot = value.trim().replace(/^\.\//u, '');
  const normalized = path.posix.normalize(withoutDot);
  const issue = portablePathIssue(normalized);
  if (issue) return { ok: false, reason: issue };
  if (normalized !== withoutDot) return { ok: false, reason: 'must be canonical (no ./, ../, or //)' };
  return { ok: true, value: normalized };
}

export function portablePathIssue(relativePath) {
  if (!relativePath) return 'path is empty';  if (!/^[\x00-\x7f]*$/u.test(relativePath)) return 'is not ASCII';
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(relativePath)) {
    return 'is absolute';
  }
  if (relativePath.includes('\\')) return 'contains a backslash';
  if (relativePath.endsWith('/')) return 'has a trailing slash';
  if (/[\x00-\x1f\x7f]/u.test(relativePath)) return 'contains a control character';
  if (Buffer.byteLength(relativePath, 'ascii') > LIMITS.maxPathBytes) return 'exceeds the path limit';
  const segments = relativePath.split('/');
  if (segments.length > LIMITS.maxPathSegments) return 'has too many segments';
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return 'has an empty or dot segment';
    if (Buffer.byteLength(segment, 'ascii') > LIMITS.maxSegmentBytes) return `"${segment}" exceeds the segment limit`;
    if (!PORTABLE_SEGMENT.test(segment) || segment.endsWith('.')) return `"${segment}" is not portable`;
    const [basename = ''] = segment.split('.', 1);
    if (WINDOWS_RESERVED.has(basename.toLowerCase())) return `"${segment}" is reserved on Windows`;
  }
  return undefined;
}

// The Host keeps a name for every prefix of every path in the package, folded to lower case,
// and refuses two paths that land on the same name. A package that holds both `README.md` and
// `Readme.md` is refused there, so the same folding belongs here.
export function registerPortablePrefix(prefixes, relativePath) {
  const segments = relativePath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const key = prefix.normalize('NFC').toLocaleLowerCase('en-US');
    const prior = prefixes.get(key);
    if (prior !== undefined && prior !== prefix) return [prior, prefix];
    prefixes.set(key, prefix);
  }
  return undefined;
}

export function normalizeRoutePath(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'must be a non-empty route path' };
  const route = value.trim();
  if (route.includes('://') || route.startsWith('//')) return { ok: false, reason: 'must not contain an origin' };
  if (route.includes('\\') || route.includes('?') || route.includes('#')) {
    return { ok: false, reason: 'must not contain a backslash, query, or fragment' };
  }
  const withSlash = route.startsWith('/') ? route : `/${route}`;
  if (path.posix.normalize(withSlash) !== withSlash) return { ok: false, reason: 'must be canonical' };
  return { ok: true, value: withSlash };
}

export function isCoveredBy(relativePath, roots) {
  return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}
