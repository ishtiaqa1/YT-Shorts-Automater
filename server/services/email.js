/**
 * Sends email via Resend HTTP API when RESEND_API_KEY is set, else logs only (dev-safe).
 */

function appName() {
  return process.env.APP_NAME?.trim() || 'ClipForge';
}

/**
 * @param {{ to: string; subject: string; html: string; text?: string }} opts
 */
export async function sendEmail(opts) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || `onboarding@${appName().toLowerCase().replace(/\s+/g, '')}.com`;

  const bodyText = opts.text ?? opts.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (!key) {
    console.log(`[email stub] To: ${opts.to} | ${opts.subject}\n${bodyText.slice(0, 320)}`);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: bodyText,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${raw.slice(0, 400)}`);
  }
  return { ok: true, raw };
}

export async function mailRenderReady(to, title, projectUrl) {
  const name = appName();
  return sendEmail({
    to,
    subject: `Your Short “${title}” is ready`,
    html: `<p><strong>${name}</strong></p><p>Your Short <strong>${escapeHtml(title)}</strong> finished rendering.</p><p>Open the editor to review and schedule:${projectUrl ? ` <a href="${escapeHtml(projectUrl)}">Open project</a>` : ''}</p>`,
  });
}

export async function mailUploadSuccess(to, title, videoUrl, hostLabel = 'YouTube') {
  const name = appName();
  const where = escapeHtml(hostLabel);
  return sendEmail({
    to,
    subject: `Your Short “${title}” went live`,
    html: `<p><strong>${name}</strong></p><p><strong>${escapeHtml(title)}</strong> is on ${where}.</p>${videoUrl ? `<p><a href="${escapeHtml(videoUrl)}">Watch</a></p>` : ''}`,
  });
}

export async function mailUploadFailed(to, title, reason, retryUrl) {
  const name = appName();
  return sendEmail({
    to,
    subject: `Upload failed for “${title}”`,
    html: `<p><strong>${name}</strong></p><p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(reason)}</p>${retryUrl ? `<p><a href="${escapeHtml(retryUrl)}">Open project</a></p>` : ''}`,
  });
}

export async function mailWeeklySummary(to, statsHtml) {
  const name = appName();
  return sendEmail({
    to,
    subject: `${name} — weekly recap`,
    html: `<p>Hi,</p>${statsHtml}<p>— ${name}</p>`,
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
