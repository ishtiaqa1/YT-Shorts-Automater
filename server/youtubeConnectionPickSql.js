/**
 * SQL fragment: resolve which `youtube_connections` row to use for a scheduled upload.
 * `su` must be the alias for `scheduled_uploads`.
 *
 * Prefers an explicit `youtube_connection_id` on the schedule row, then any default
 * channel, then the most recently updated connection (covers legacy rows where no default was set).
 */
export function pickYoutubeConnectionIdSql(suAlias = 'su') {
  return `COALESCE(
    ${suAlias}.youtube_connection_id,
    (SELECT id FROM youtube_connections WHERE user_id = ${suAlias}.user_id
     ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT 1)
  )`;
}
