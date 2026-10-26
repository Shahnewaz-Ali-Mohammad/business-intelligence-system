import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAppDb } from '@/lib/db/app-db';
import { permissionsFor, coveredDepartments, DATA_ROLES } from './permissions.mjs';

export type Access = {
  userId: number;
  roles: string[];
  permissions: string[];
  /** Departments assigned to the person. */
  assignedDepartmentIds: number[];
  /** Assigned departments plus, for Managers, every department below them. */
  departmentIds: number[];
  departmentNames: string[];
  allData: boolean;
  dataRole: boolean;
  /** Admin testing a tool in Tool setup. */
  setupPreview?: boolean;
  /** Reads the data access rules for a database connection. */
  policyFor?: (config: { dialect?: string; host: string; port: number; database?: string }) => Promise<DataPolicy | null>;
};
export type Department = { id: number; name: string; parentId: number | null };
export type DataPolicy = {
  departmentField?: string;
  departmentValues?: Record<string, string[]>;
  tables?: Record<string, 'department' | 'shared' | 'restricted'>;
  procedures?: Record<string, { parameter: string }>;
};

let ready: Promise<void> | null = null;
/** Creates the access tables once per process; the first users become Admin + CEO so nobody is locked out. */
export function ensureAccessSchema() {
  if (!ready) {
    ready = (async () => {
      const db = getAppDb();
      const file = path.join(process.cwd(), 'database', 'access-control-migration.sql');
      const statements = readFileSync(file, 'utf8').replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
      for (const sql of statements) await db.query(sql);
      const [[{ assigned }]] = (await db.query('SELECT COUNT(*) AS assigned FROM user_roles')) as unknown as [[{ assigned: number }]];
      if (Number(assigned) === 0) {
        await db.query("INSERT IGNORE INTO user_roles (user_id, role) SELECT id, 'admin' FROM users");
        await db.query("INSERT IGNORE INTO user_roles (user_id, role) SELECT id, 'ceo' FROM users");
        console.log('[access] No roles existed: every existing user was made Admin + CEO. Adjust them on the Users page.');
      }
    })().catch((error) => { ready = null; throw error; });
  }
  return ready;
}

export async function listDepartments(): Promise<Department[]> {
  await ensureAccessSchema();
  const [rows] = await getAppDb().execute('SELECT id, name, parent_id FROM departments ORDER BY name');
  return (rows as { id: number; name: string; parent_id: number | null }[]).map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
}

/** Everything the app needs to decide what this person may do and see, read fresh on every request. */
export async function loadAccess(userId: number): Promise<Access> {
  await ensureAccessSchema();
  const db = getAppDb();
  const [roleRows] = await db.execute('SELECT role FROM user_roles WHERE user_id=?', [userId]);
  const [deptRows] = await db.execute('SELECT department_id FROM user_departments WHERE user_id=?', [userId]);
  const roles = (roleRows as { role: string }[]).map((r) => r.role);
  const assigned = (deptRows as { department_id: number }[]).map((r) => Number(r.department_id));
  const departments = await listDepartments();
  const covered = coveredDepartments(assigned, departments, roles.includes('manager'));
  const permissions = permissionsFor(roles);
  return {
    userId,
    roles,
    permissions,
    assignedDepartmentIds: assigned,
    departmentIds: covered,
    departmentNames: departments.filter((d) => covered.includes(d.id)).map((d) => d.name),
    allData: permissions.includes('data.all'),
    dataRole: roles.some((r) => DATA_ROLES.includes(r)),
    policyFor: policyForConfig,
  };
}

export const sourceKey = (config: { dialect?: string; host: string; port: number; database?: string }) =>
  `${config.dialect || 'sqlserver'}://${String(config.host).toLowerCase()}:${config.port}/${String(config.database || '').toLowerCase()}`;

const policyCache = new Map<string, { at: number; policy: DataPolicy | null }>();
export async function policyForConfig(config: Parameters<typeof sourceKey>[0]): Promise<DataPolicy | null> {
  const key = sourceKey(config);
  const hit = policyCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.policy;
  await ensureAccessSchema();
  const [rows] = await getAppDb().execute('SELECT policy FROM data_policies WHERE source_key=? LIMIT 1', [key]);
  const raw = (rows as { policy: unknown }[])[0]?.policy;
  const policy = raw == null ? null : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as DataPolicy);
  policyCache.set(key, { at: Date.now(), policy });
  return policy;
}
export async function getPolicy(sourceId: string): Promise<DataPolicy | null> {
  await ensureAccessSchema();
  const [rows] = await getAppDb().execute('SELECT policy FROM data_policies WHERE source_id=?', [sourceId]);
  const raw = (rows as { policy: unknown }[])[0]?.policy;
  return raw == null ? null : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as DataPolicy);
}
export async function savePolicy(sourceId: string, key: string, policy: DataPolicy, userId: number) {
  await ensureAccessSchema();
  await getAppDb().execute(
    'INSERT INTO data_policies (source_id, source_key, policy, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE source_key=VALUES(source_key), policy=VALUES(policy), updated_by=VALUES(updated_by)',
    [sourceId, key, JSON.stringify(policy), userId],
  );
  policyCache.clear();
}

/** Records who did what. Never blocks the request it describes. */
export async function audit(userId: number | null, action: string, target?: string | null, details?: Record<string, unknown>) {
  try {
    await ensureAccessSchema();
    await getAppDb().execute('INSERT INTO audit_log (user_id, action, target, details) VALUES (?, ?, ?, ?)', [userId, action, target ? String(target).slice(0, 255) : null, details ? JSON.stringify(details).slice(0, 60000) : null]);
  } catch (error) {
    console.error('[audit] could not record', action, error instanceof Error ? error.message : error);
  }
}
