/**
 * SQL fragment: resolve which `tiktok_connections` row to use for a scheduled upload.
 * `su` must be the alias for `scheduled_uploads`.
 */
export function pickTiktokConnectionIdSql(suAlias = 'su') {
  return `COALESCE(
    ${suAlias}.tiktok_connection_id,
    (SELECT id FROM tiktok_connections WHERE user_id = ${suAlias}.user_id
     ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST LIMIT 1)
  )`;
}
