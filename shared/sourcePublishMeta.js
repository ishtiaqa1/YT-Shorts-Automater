/**
 * Source-aware hashtags for YouTube only (description footer + snippet.tags derivation).
 * Burned-in subtitles use script / caption_text only — no auto hashtags on the video.
 */

const MAX_YOUTUBE_TAGS = 12;

/** @param {string | null | undefined} redditPermalink */
export function parseSubredditName(redditPermalink) {
  if (!redditPermalink || typeof redditPermalink !== 'string') return null;
  const m = redditPermalink.match(/\/r\/([^/?#]+)/i);
  if (!m) return null;
  return sanitizeTagToken(m[1]);
}

/** @param {string} s */
export function sanitizeTagToken(s) {
  const t = String(s || '')
    .replace(/^#+/u, '')
    .replace(/\s+/gu, '')
    .replace(/[^\w-]/gu, '')
    .slice(0, 30);
  return t.length >= 2 ? t.toLowerCase() : null;
}

/** @param {string | null | undefined} st */
function sourceTypeBucket(st) {
  const v = String(st || 'manual').toLowerCase();
  if (v === 'reddit' || v === 'ai' || v === 'spoken') return v;
  return 'manual';
}

/**
 * Light script cues for extra discoverability (YouTube tags / description).
 * @param {string | null | undefined} scriptText
 * @returns {string[]}
 */
export function inferScriptHashtagTokens(scriptText) {
  const s = String(scriptText || '');
  const lower = s.toLowerCase();
  const out = [];
  if (/\baita\b/i.test(s) || lower.includes('am i the asshole')) out.push('aita');
  if (/\btifu\b/i.test(s) || lower.includes('today i fucked up')) out.push('tifu');
  if (lower.includes('relationship advice') || lower.includes('relationship_advice')) out.push('relationship');
  return out.map((x) => sanitizeTagToken(x)).filter(Boolean);
}

/**
 * Space-separated hashtags with `#` for the YouTube description footer (not burned into the MP4).
 * @param {{ sourceType?: string | null, redditPermalink?: string | null, scriptText?: string | null }} opts
 */
export function buildCaptionAndDescriptionHashtagLine(opts) {
  const { sourceType, redditPermalink, scriptText } = opts || {};
  const st = sourceTypeBucket(sourceType);
  const parts = [];
  if (st === 'reddit') {
    parts.push('#shorts', '#reddit', '#redditstory');
    const sub = parseSubredditName(redditPermalink);
    if (sub) parts.push(`#${sub}`);
  } else if (st === 'ai') {
    parts.push('#shorts', '#ai', '#story');
  } else if (st === 'spoken') {
    parts.push('#shorts', '#storytime', '#spoken');
  } else {
    parts.push('#shorts', '#story');
  }

  for (const tok of inferScriptHashtagTokens(scriptText)) {
    parts.push(`#${tok}`);
  }

  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 10) break;
  }
  return out.join(' ');
}

/**
 * @param {unknown[]} userTags
 * @param {{ sourceType?: string | null, redditPermalink?: string | null, scriptText?: string | null }} opts
 * @returns {string[]}
 */
export function buildYoutubeSnippetTags(userTags, opts) {
  const line = buildCaptionAndDescriptionHashtagLine(opts);
  const fromLine = line
    .split(/\s+/u)
    .map((t) => t.replace(/^#+/u, '').toLowerCase())
    .map((t) => sanitizeTagToken(t))
    .filter(Boolean);

  const merged = [];
  const seen = new Set();
  if (Array.isArray(userTags)) {
    for (const raw of userTags) {
      const t = sanitizeTagToken(String(raw || '').replace(/^#+/u, ''));
      if (!t || seen.has(t)) continue;
      seen.add(t);
      merged.push(t);
      if (merged.length >= MAX_YOUTUBE_TAGS) return merged;
    }
  }
  for (const t of fromLine) {
    if (merged.length >= MAX_YOUTUBE_TAGS) break;
    if (seen.has(t)) continue;
    seen.add(t);
    merged.push(t);
  }
  if (!seen.has('shorts') && merged.length < MAX_YOUTUBE_TAGS) {
    merged.push('shorts');
    seen.add('shorts');
  }
  return merged.slice(0, MAX_YOUTUBE_TAGS);
}

/**
 * @param {string} description
 * @param {{ sourceType?: string | null, redditPermalink?: string | null, scriptText?: string | null }} opts
 */
export function appendHashtagsToYoutubeDescription(description, opts) {
  const line = buildCaptionAndDescriptionHashtagLine(opts);
  if (!line) return String(description || '');
  let desc = String(description || '').trimEnd();
  const footer = `\n\n${line}`;
  const maxLen = 4900;
  if (desc.length + footer.length <= maxLen) return desc + footer;
  const room = Math.max(0, maxLen - footer.length);
  desc = desc.slice(0, room).trimEnd();
  return desc + footer;
}
