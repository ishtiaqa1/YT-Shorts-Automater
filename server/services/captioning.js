/**
 * Build rough-timed SRT from full script + audio duration (seconds).
 * Splits on sentence boundaries when possible, otherwise chunks by words.
 */
export function buildSrtFromScript(script, durationSec) {
  const clean = script.replace(/\s+/g, ' ').trim();
  if (!clean || durationSec <= 0) return '1\n00:00:00,000 --> 00:00:01,000\n.\n';

  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks =
    sentences.length > 0
      ? sentences
      : clean.match(/.{1,80}(\s|$)/g) || [clean];

  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let msCursor = 0;
  const blocks = [];

  chunks.forEach((text, i) => {
    const share = text.length / totalChars;
    let chunkMs = Math.round(durationSec * 1000 * share);
    if (i === chunks.length - 1) {
      chunkMs = Math.max(0, Math.round(durationSec * 1000) - msCursor);
    }
    const start = msCursor;
    const end = Math.min(msCursor + chunkMs, Math.round(durationSec * 1000));
    msCursor = end;
    blocks.push({ text: text.trim(), start, end });
  });

  return blocks
    .map((b, idx) => {
      const a = formatTs(b.start);
      const z = formatTs(Math.max(b.start + 1, b.end));
      return `${idx + 1}\n${a} --> ${z}\n${b.text}\n`;
    })
    .join('\n');
}

function formatTs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msr = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(msr).padStart(3, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
