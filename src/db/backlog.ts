import { db } from './db';
import { loadSettings, setSetting } from './settings';

/**
 * Compare the running app version with the one recorded at the last startup.
 * When it differs, remove the backlog rows that were already exported and record the new version.
 * Returns the number of deleted rows.
 */
export async function syncAppVersion(buildVersion: string): Promise<number> {
  const s = await loadSettings();
  if (s.appVersion === buildVersion) return 0;
  const rows = await db.backlog.toArray();
  const exported = rows.filter((r) => (r.status ?? 'new') === 'exported');
  if (exported.length > 0) await db.backlog.bulkDelete(exported.map((r) => r.id!));
  await setSetting('appVersion', buildVersion);
  return exported.length;
}

/** Mark every backlog row as exported (called after "copy all" / ".md download"). */
export async function markAllBacklogExported(): Promise<void> {
  await db.backlog.toCollection().modify({ status: 'exported' });
}
