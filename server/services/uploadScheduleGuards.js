/**
 * Guards against duplicate YouTube queue rows for the same rendered MP4
 * (`output_revision` bumps on each successful render; `last_queued_output_revision`
 * is set when schedule rows are committed).
 */

/** @param {import('pg').Pool | import('pg').PoolClient} poolConn */
export async function countActiveUploadQueueForProject(poolConn, projectId) {
  const { rows } = await poolConn.query(
    `SELECT COUNT(*)::int AS c FROM scheduled_uploads
     WHERE project_id = $1::uuid AND status IN ('pending', 'uploading')`,
    [projectId]
  );
  return Number(rows[0]?.c ?? 0);
}

/** @param {{ output_revision?: unknown; last_queued_output_revision?: unknown }} project */
export function sameOutputRevisionAlreadyQueued(project, forceRepeat) {
  if (forceRepeat) return false;
  const outRev = Number(project?.output_revision ?? 0);
  const lastq = project?.last_queued_output_revision;
  if (lastq == null || lastq === '') return false;
  return Number(lastq) === outRev;
}
