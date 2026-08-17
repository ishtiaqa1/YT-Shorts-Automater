/**
 * Map YouTube Data API / Gaxios error text to short, actionable UI copy.
 */
export function describeYoutubeUploadError(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';

  if (/uploadLimitExceeded/i.test(s)) {
    return (
      'YouTube hit its daily upload limit for this channel (not a Shorts Studio bug). ' +
      'The cap resets over time—often within about 24 hours. Schedule fewer uploads per day or try again tomorrow. [uploadLimitExceeded]'
    );
  }
  if (/quotaExceeded/i.test(s)) {
    return (
      'YouTube API quota for this application is used up for today. Try again after it resets (typically midnight Pacific). [quotaExceeded]'
    );
  }
  if (/invalidGrant|invalid_grant|Token has been expired|revoked/i.test(s)) {
    return 'YouTube sign-in for this channel is invalid or expired. Open Settings and reconnect YouTube.';
  }
  if (/invalidPublishTime|invalidPublish/i.test(s)) {
    return (
      'YouTube rejected the scheduled publish time (too soon or invalid). Pick a time at least ~25 minutes from now when scheduling.'
    );
  }

  return s;
}
