import { unlink } from 'fs/promises';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createCanvas, loadImage } from 'canvas';

/**
 * @param {string | null | undefined} permalinkRaw
 * @returns {string} e.g. `r/AskReddit` or empty
 */
function extractSubredditFromPermalink(permalinkRaw) {
  const u = String(permalinkRaw || '').trim();
  if (!u) return '';
  const m = u.match(/reddit\.com\/r\/([^/?#]+)/i);
  return m ? `r/${m[1]}` : '';
}

/** @param {string} s */
function normalizeSubredditDisplay(s) {
  let t = String(s || '')
    .trim()
    .replace(/^\/+/, '');
  if (!t) return 'r/Reddit';
  if (!/^r\//i.test(t)) t = `r/${t.replace(/^r\//i, '')}`;
  if (t.length < 4) return 'r/Reddit';
  return t;
}

/** @param {string} s */
function hashString(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Reddit-feed style background (light grey).
 * @param {CanvasRenderingContext2D} ctx
 */
function drawRedditFeedBackground(ctx, w, h) {
  ctx.fillStyle = '#f0f2f5';
  ctx.fillRect(0, 0, w, h);
}

/**
 * Minimal Snoo-style mark: orange disc + simple white face (readable at small sizes).
 * @param {CanvasRenderingContext2D} ctx
 */
function drawRedditSnooAvatar(ctx, x, y, d) {
  const cx = x + d / 2;
  const cy = y + d / 2;
  const r = d / 2;
  ctx.fillStyle = '#ff4500';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx - r * 0.2, cy - r * 0.06, r * 0.14, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.2, cy - r * 0.06, r * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, r * 0.1);
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.12, r * 0.32, 0.12 * Math.PI, 0.88 * Math.PI);
  ctx.stroke();
}

/**
 * Coloured “award” pills like the mobile post header strip.
 * @param {CanvasRenderingContext2D} ctx
 */
function drawRedditAwardRow(ctx, x, y, rowW, dotD) {
  const colours = [
    '#ffd700',
    '#c8ccd0',
    '#cd7f32',
    '#ff4500',
    '#7193ff',
    '#45d1da',
    '#f45385',
    '#ff8717',
    '#d0021b',
    '#7cb342',
  ];
  const gap = Math.max(4, Math.round(dotD * 0.28));
  let xx = x;
  for (let i = 0; i < colours.length && xx + dotD < x + rowW; i += 1) {
    ctx.fillStyle = colours[i];
    ctx.beginPath();
    ctx.arc(xx + dotD / 2, y + dotD / 2, dotD / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    xx += dotD + gap;
  }
}

/**
 * Upvotes / comments / share row (grey, like Reddit mobile).
 * @param {CanvasRenderingContext2D} ctx
 */
function drawRedditPostFooterBar(ctx, x, y, rowW, seedStr) {
  const seed = hashString(seedStr);
  const up = 180 + (seed % 420);
  const cm = 20 + (seed % 140);
  const fontPx = Math.max(20, Math.round(rowW * 0.038));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#878a8c';
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const midY = y + fontPx * 0.55;
  const left1 = `▲ ${up}`;
  ctx.fillText(left1, x, midY);
  const w1 = ctx.measureText(left1).width;
  const gap = Math.round(rowW * 0.06);
  ctx.fillText(`Comments ${cm}`, x + w1 + gap, midY);
  ctx.textAlign = 'right';
  ctx.fillText('Share', x + rowW, midY);
}

/**
 * White rounded “post card” with subreddit row, awards, title, footer — matches common Reddit-story templates.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cw canvas width
 * @param {number} ch usable height (full 1920 for title PNG, or ~960 for composite top half)
 * @param {{ subreddit: string; title: string }} opts
 */
function drawRedditMobilePostCardTemplate(ctx, cw, ch, { subreddit, title }) {
  const scale = Math.min(1, ch / 1000);
  const sideMargin = Math.round(40 * scale);
  const rx = sideMargin;
  const ry = Math.round(72 * scale);
  const rw = cw - sideMargin * 2;
  const rh = Math.min(Math.floor(ch * 0.78), Math.floor(ch - ry - 48 * scale));

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  roundRectPath(ctx, rx + 3, ry + 5, rw, rh, 22 * scale);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  roundRectPath(ctx, rx, ry, rw, rh, 20 * scale);
  ctx.fill();
  ctx.strokeStyle = '#0f0f0f';
  ctx.lineWidth = Math.max(2, 3 * scale);
  roundRectPath(ctx, rx, ry, rw, rh, 20 * scale);
  ctx.stroke();

  const padX = Math.round(32 * scale);
  const avatarD = Math.round(56 * scale);
  let cx = rx + padX;
  let cy = ry + Math.round(36 * scale);

  drawRedditSnooAvatar(ctx, cx, cy, avatarD);

  cx += avatarD + Math.round(16 * scale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0f1419';
  const subFont = Math.max(24, Math.round(38 * scale));
  ctx.font = `bold ${subFont}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  const subLine = String(subreddit || 'r/Reddit').slice(0, 40);
  ctx.fillText(subLine, cx, cy + avatarD / 2);

  cy = ry + Math.round(36 * scale) + avatarD + Math.round(14 * scale);
  cx = rx + padX;
  const dotD = Math.round(24 * scale);
  drawRedditAwardRow(ctx, cx, cy, rw - padX * 2, dotD);

  cy += dotD + Math.round(28 * scale);
  const titleMaxW = rw - padX * 2;
  const rawTitle = String(title || '').trim() || 'Reddit story';
  let fontPx = Math.max(30, Math.round(52 * scale));
  /** @type {string[]} */
  let lines = [];
  for (; fontPx >= 26; fontPx -= 2) {
    ctx.font = `bold ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    lines = wrapLinesForMeasure(ctx, rawTitle, titleMaxW, 9);
    const blockH = lines.length * fontPx * 1.2;
    if (blockH <= ry + rh - cy - Math.round(88 * scale) || fontPx <= 28) break;
  }
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#0f1419';
  for (const ln of lines) {
    ctx.fillText(ln, rx + padX, cy);
    cy += fontPx * 1.2;
    if (cy > ry + rh - Math.round(80 * scale)) break;
  }

  const footY = ry + rh - Math.round(52 * scale);
  drawRedditPostFooterBar(ctx, rx + padX, footY, rw - padX * 2, rawTitle);
}

/**
 * Vertical title thumbnail (1080×1920 PNG).
 * @param {{
 *   titleText: string;
 *   subtitleText?: string;
 *   destPath: string;
 *   sourceType?: string | null;
 *   redditPermalink?: string | null;
 * }} opts
 */
export async function generateTitleThumbnailPng({
  titleText,
  subtitleText,
  destPath,
  sourceType,
  redditPermalink,
}) {
  const w = 1080;
  const h = 1920;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  const reddit = String(sourceType || '').toLowerCase() === 'reddit';

  if (reddit) {
    /** @type {Awaited<ReturnType<typeof fetchRedditPostPreview>> | null} */
    let meta = null;
    if (redditPermalink) {
      meta = await fetchRedditPostPreview(redditPermalink);
    }
    const projectTitle = String(titleText || '').trim();
    const displayTitle = projectTitle || String(meta?.title || '').trim() || 'Reddit story';
    let subLabel =
      (meta?.subreddit && String(meta.subreddit).trim()) ||
      extractSubredditFromPermalink(String(redditPermalink || '')) ||
      'r/Reddit';
    subLabel = normalizeSubredditDisplay(subLabel);

    drawRedditFeedBackground(ctx, w, h);
    drawRedditMobilePostCardTemplate(ctx, w, h, { subreddit: subLabel, title: displayTitle });
  } else {
    const displayTitle = titleText || 'Your Short';
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1a0a2e');
    grad.addColorStop(1, '#16213e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 92px Arial Black';
    wrapTextLines(ctx, displayTitle, w / 2, 760, w - 120, 92, 3);
    if (subtitleText) {
      ctx.font = '36px Arial';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(subtitleText.slice(0, 80), w / 2, 1460);
    }
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, canvas.toBuffer('image/png'));
  return destPath;
}

/**
 * Full-frame Reddit “card” PNG for the opening beat of a render (same look as the title-card canvas).
 * @param {{ redditPermalink: string; titleFallback?: string | null; destPath: string }} opts
 */
export async function writeRedditIntroCardPng({ redditPermalink, titleFallback, destPath }) {
  const pm = String(redditPermalink || '').trim();
  if (!pm) throw new Error('reddit permalink required for intro card');
  await generateTitleThumbnailPng({
    titleText: String(titleFallback || '').trim() || 'Reddit story',
    subtitleText: '',
    destPath,
    sourceType: 'reddit',
    redditPermalink: pm,
  });
  return destPath;
}

/**
 * Top = Reddit preview (image or text-post card); bottom = full-HD frame from rendered video.
 * @param {{ videoFrameJpgPath: string; redditPermalink: string; destPath: string }} opts
 */
export async function compositeRedditVideoFrameThumbnail({ videoFrameJpgPath, redditPermalink, destPath }) {
  const w = 1080;
  const h = 1920;
  const yMid = Math.floor(h * 0.5);

  const meta = await fetchRedditPostPreview(redditPermalink);
  if (!meta) {
    console.warn('[thumbnail] composite: Reddit .json fetch failed or unreadable — top half is placeholder only');
  }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  /** Upper half: same mobile post card as title / intro */
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, yMid);
  ctx.clip();
  const displayTitle = String(meta?.title || '').trim() || 'Reddit story';
  let subLabel =
    (meta?.subreddit && String(meta.subreddit).trim()) ||
    extractSubredditFromPermalink(String(redditPermalink || '')) ||
    'r/Reddit';
  subLabel = normalizeSubredditDisplay(subLabel);
  drawRedditFeedBackground(ctx, w, yMid);
  drawRedditMobilePostCardTemplate(ctx, w, yMid, { subreddit: subLabel, title: displayTitle });
  ctx.restore();

  /** Lower half: your Short frame */
  const vid = await loadImage(videoFrameJpgPath);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, yMid, w, h - yMid);
  ctx.clip();
  drawImageCoverInRect(ctx, vid, 0, yMid, w, h - yMid);
  ctx.restore();

  /** Divider between post + gameplay */
  const band = ctx.createLinearGradient(0, yMid - 3, 0, yMid + 52);
  band.addColorStop(0, 'rgba(0,0,0,0.75)');
  band.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, yMid - 3, w, 55);

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, canvas.toBuffer('image/png'));

  /** Clean up temp JPG when compositing writes a sibling PNG beside it. */
  if (videoFrameJpgPath !== destPath) {
    await unlink(videoFrameJpgPath).catch(() => {});
  }
  return destPath;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 */
function wrapLinesForMeasure(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const ww of words) {
    const trial = line ? `${line} ${ww}` : ww;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = ww;
      if (lines.length >= maxLines) break;
    } else {
      line = trial;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.slice(0, maxLines);
}

/** @param {import('canvas').Image} img */
function drawImageCoverInRect(ctx, img, dx, dy, rw, rh) {
  const iw = img.width;
  const ih = img.height;
  const scale = Math.max(rw / iw, rh / ih);
  const nw = Math.round(iw * scale);
  const nh = Math.round(ih * scale);
  const ox = dx + Math.round((rw - nw) / 2);
  const oy = dy + Math.round((rh - nh) / 2);
  ctx.drawImage(img, ox, oy, nw, nh);
}

function fixRedditAmp(u) {
  let s = String(u || '').replace(/&amp;/g, '&');
  if (s.startsWith('//')) s = `https:${s}`;
  return s;
}

/** Reddit JSON often returns protocol-relative or HTML-escaped image URLs. */
function normalizeMediaUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (['self', 'default', 'nsfw', 'spoiler', 'image'].includes(lower)) return null;
  let u = fixRedditAmp(t);
  if (u.startsWith('//')) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function extractGalleryFirstImageUrl(post) {
  try {
    const items = post?.gallery_data?.items;
    const metaMap = post?.media_metadata;
    if (!Array.isArray(items) || !items.length || !metaMap || typeof metaMap !== 'object') return null;
    const firstId = items[0]?.media_id;
    if (!firstId || !metaMap[firstId]) return null;
    const m = metaMap[firstId];
    const cand = m?.s?.u || m?.s?.gif || (Array.isArray(m?.p) && m.p.length ? m.p[m.p.length - 1]?.u : null);
    return cand || null;
  } catch {
    return null;
  }
}

/** Prefer largest preview still URL (Reddit orders resolutions ascending). */
function largestPreviewImageUrl(post) {
  const imgs = post?.preview?.images?.[0];
  if (!imgs) return null;
  if (imgs.source?.url) return imgs.source.url;
  const res = imgs.resolutions;
  if (!Array.isArray(res) || !res.length) return null;
  const sorted = [...res].sort((a, b) => (b?.width || 0) - (a?.width || 0));
  return sorted[0]?.url || null;
}

/**
 * Best-effort lead image for a Reddit post listing object (self, link, gallery, crosspost).
 * @param {Record<string, unknown>} post
 * @param {number} [depth]
 * @returns {string | null}
 */
function pickLeadImageUrlFromPost(post, depth = 0) {
  if (!post || typeof post !== 'object' || depth > 3) return null;

  const gal = normalizeMediaUrl(extractGalleryFirstImageUrl(post));
  if (gal) return gal;

  let imageUrl = normalizeMediaUrl(largestPreviewImageUrl(post));
  if (!imageUrl) {
    imageUrl = normalizeMediaUrl(post.preview?.images?.[0]?.source?.url);
  }

  const directRaw = typeof post.url === 'string' ? post.url.trim() : '';
  const direct = normalizeMediaUrl(directRaw);
  if (
    !imageUrl &&
    direct &&
    /\.(jpe?g|png|gif|webp)(\?|$)/i.test(direct.split('?')[0])
  ) {
    imageUrl = direct;
  }

  const thumbRaw = typeof post.thumbnail === 'string' ? post.thumbnail.trim() : '';
  const thumbNorm = normalizeMediaUrl(thumbRaw);
  if (
    !imageUrl &&
    thumbNorm &&
    !['self', 'default', 'nsfw', 'spoiler', 'image'].includes(thumbRaw.toLowerCase())
  ) {
    imageUrl = thumbNorm;
  }

  if (!imageUrl && Array.isArray(post.crosspost_parent_list) && post.crosspost_parent_list[0]) {
    return pickLeadImageUrlFromPost(post.crosspost_parent_list[0], depth + 1);
  }

  return imageUrl || null;
}

/** @returns {Promise<{ title?: string; imageUrl?: string; subreddit?: string; selftextSnippet?: string } | null>} */
async function fetchRedditPostPreview(permalinkRaw) {
  const raw = String(permalinkRaw || '').trim();
  if (!raw) return null;
  const noQuery = raw.split('?')[0].replace(/\/+$/, '');
  const jsonUrl = noQuery.endsWith('.json') ? noQuery : `${noQuery}.json`;
  try {
    const r = await fetch(jsonUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 shorts-studio/1.0',
        Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;
    const title = typeof post.title === 'string' ? post.title : undefined;

    let selftextSnippet = '';
    if (typeof post.selftext === 'string') {
      selftextSnippet = post.selftext
        .replace(/\r/g, '')
        .replace(/\[([^\]]+)]\(https?:[^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3800);
    }
    if (!selftextSnippet && Array.isArray(post.crosspost_parent_list) && post.crosspost_parent_list[0]) {
      const parent = post.crosspost_parent_list[0];
      if (typeof parent.selftext === 'string') {
        selftextSnippet = parent.selftext
          .replace(/\r/g, '')
          .replace(/\[([^\]]+)]\(https?:[^)]+\)/g, '$1')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3800);
      }
    }

    const imageUrl = pickLeadImageUrlFromPost(post);

    const subreddit =
      typeof post.subreddit_name_prefixed === 'string'
        ? post.subreddit_name_prefixed
        : typeof post.subreddit === 'string'
          ? `r/${post.subreddit}`
          : undefined;
    return {
      title,
      imageUrl: imageUrl || undefined,
      subreddit,
      selftextSnippet: selftextSnippet || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 */
function wrapTextLines(ctx, text, x, y, maxWidth, fontSizePx, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines - 1) break;
    } else {
      line = trial;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);

  lines.slice(0, maxLines).forEach((ln, i) => {
    ctx.fillText(ln, x, y + i * (fontSizePx * 1.05));
  });
}

/**
 * Word-wrap with stroke + fill per line (readable on busy backgrounds).
 * @param {{ fill: string; stroke: string; lineWidth: number }} style
 */
function wrapStrokeTextLines(ctx, text, x, y, maxWidth, fontSizePx, maxLines, style) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines - 1) break;
    } else {
      line = trial;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);

  const slice = lines.slice(0, maxLines);
  const lineHeight = fontSizePx * 1.12;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  slice.forEach((ln, i) => {
    const yy = y + i * lineHeight;
    ctx.lineWidth = style.lineWidth;
    ctx.strokeStyle = style.stroke;
    ctx.strokeText(ln, x, yy);
    ctx.fillStyle = style.fill;
    ctx.fillText(ln, x, yy);
  });
}
