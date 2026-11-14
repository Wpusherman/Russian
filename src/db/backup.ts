import { db, EXPORT_TABLES, SCHEMA_VERSION } from './db';
import { reapplyUserData } from './dict';

export type Backup = { app: 'ruslo'; schemaVersion: number; exportedAt: string; tables: Record<string, unknown[]> };

/** Every table except `lemmas`, as one JSON object. */
export async function exportAll(): Promise<Backup> {
  const tables: Record<string, unknown[]> = {};
  for (const name of EXPORT_TABLES) tables[name] = await db.table(name).toArray();
  return { app: 'ruslo', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables };
}

export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み取れません。');
  }
  const b = data as Partial<Backup>;
  if (!b || b.app !== 'ruslo' || typeof b.tables !== 'object' || b.tables === null) throw new Error('Rusloのエクスポートファイルではありません。');
  if (typeof b.schemaVersion !== 'number' || b.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`このファイルのスキーマバージョン (${String(b.schemaVersion)}) には対応していません。`);
  }
  for (const name of EXPORT_TABLES) {
    const t = (b.tables as Record<string, unknown>)[name];
    if (t !== undefined && !Array.isArray(t)) throw new Error(`テーブル ${name} の形式が不正です。`);
  }
  return b as Backup;
}

/** Full replace of every exported table. The dictionary itself (lemmas / dictVersion) is kept. */
export async function importAll(backup: Backup): Promise<void> {
  const dictVersion = await db.settings.get('dictVersion');
  const tables = EXPORT_TABLES.map((n) => db.table(n));
  await db.transaction('rw', tables, async () => {
    for (const name of EXPORT_TABLES) {
      const t = db.table(name);
      await t.clear();
      const rows = backup.tables[name] ?? [];
      if (rows.length > 0) await t.bulkPut(rows);
    }
    if (dictVersion) await db.settings.put(dictVersion);
  });
  // Drop glosses / user words of the previous data set, then apply the imported ones.
  await db.lemmas.filter((l) => !!l.user).delete();
  await db.lemmas.filter((l) => l.glossJa !== undefined).modify((l) => { delete l.glossJa; });
  await reapplyUserData();
}
