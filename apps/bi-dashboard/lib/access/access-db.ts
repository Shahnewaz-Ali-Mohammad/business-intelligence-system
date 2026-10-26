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
  /** Admin/CEO without two-step sign-in yet: everything waits until it is set up. */
  mfaSetupRequired?: boolean;
  /** True while the access tables are not installed (everyone keeps full access). */
  notInstalled?: boolean;
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

const TABLES = ['user_status', 'departments', 'user_roles', 'user_departments', 'invitations', 'data_policies', 'audit_log', 'user_mfa', 'pending_logins'];
let ready = false;
let checkedAt = 0;
let warned = false;
/**
 * True once the access tables exist. The app's database user deliberately has
 * no CREATE/ALTER rights, so the tables are installed once by an admin with
 * `npm run db:access`. Until then the app keeps working exactly as before
 * (every signed-in user has full access) and says so in the Admin page.
 */
export async function accessReady() {
  if (ready || Date.now() - checkedAt < 30000) return ready;
  checkedAt = Date.now();
  const [rows] = await getAppDb().execute(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${TABLES.map(() => '?').join(',')})`, TABLES);
  ready = Number((rows as { n: number }[])[0].n) === TABLES.length;
  if (!ready && !warned) { warned = true; console.warn('[access] Access-control tables are not installed. Run `npm run db:access` (with SCHEMA_ADMIN_USER/SCHEMA_ADMIN_PASSWORD) to turn on roles.'); }
  return ready;
}
/** SQL for a user's disabled time (`u` = users), or NULL before the access tables exist. */
export async function disabledAtSql() { return (await accessReady()) ? '(SELECT disabled_at FROM user_status WHERE user_id=u.id)' : 'NULL'; }

/** Kept for callers that only need the tables; resolves either way. */
export async function ensureAccessSchema() { await accessReady(); }

export async function listDepartments(): Promise<Department[]> {
  if (!(await accessReady())) return [];
  const [rows] = await getAppDb().execute('SELECT id, name, parent_id FROM departments ORDER BY name');
  return (rows as { id: number; name: string; parent_id: number | null }[]).map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
}

/** Everything the app needs to decide what this person may do and see, read fresh on every request. */
export async function loadAccess(userId: number): Promise<Access> {
  if (!(await accessReady())) {
    // Roles not installed yet: same full access everyone had before roles existed.
    const roles = ['admin', 'ceo'];
    return { userId, roles, permissions: permissionsFor(roles), assignedDepartmentIds: [], departmentIds: [], departmentNames: [], allData: true, dataRole: true, notInstalled: true, policyFor: async () => null };
  }
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
    // Two-step sign-in is optional unless BI_REQUIRE_MFA=on (then Admin and CEO must use it).
    mfaSetupRequired: process.env.BI_REQUIRE_MFA === 'on' && roles.some((r) => r === 'admin' || r === 'ceo') && !(await hasMfa(userId)),
  };
}

async function hasMfa(userId: number) {
  const [rows] = await getAppDb().execute('SELECT 1 FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL', [userId]);
  return (rows as unknown[]).length > 0;
}

export const sourceKey = (config: { dialect?: string; host: string; port: number; database?: string }) =>
  `${config.dialect || 'sqlserver'}://${String(config.host).toLowerCase()}:${config.port}/${String(config.database || '').toLowerCase()}`;

const policyCache = new Map<string, { at: number; policy: DataPolicy | null }>();
export async function policyForConfig(config: Parameters<typeof sourceKey>[0]): Promise<DataPolicy | null> {
  const key = sourceKey(config);
  const hit = policyCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.policy;
  if (!(await accessReady())) return null;
  const [rows] = await getAppDb().execute('SELECT policy FROM data_policies WHERE source_key=? LIMIT 1', [key]);
  const raw = (rows as { policy: unknown }[])[0]?.policy;
  const policy = raw == null ? null : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as DataPolicy);
  policyCache.set(key, { at: Date.now(), policy });
  return policy;
}
export async function getPolicy(sourceId: string): Promise<DataPolicy | null> {
  if (!(await accessReady())) return null;
  const [rows] = await getAppDb().execute('SELECT policy FROM data_policies WHERE source_id=?', [sourceId]);
  const raw = (rows as { policy: unknown }[])[0]?.policy;
  return raw == null ? null : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as DataPolicy);
}
export async function savePolicy(sourceId: string, key: string, policy: DataPolicy, userId: number) {
  await getAppDb().execute(
    'INSERT INTO data_policies (source_id, source_key, policy, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE source_key=VALUES(source_key), policy=VALUES(policy), updated_by=VALUES(updated_by)',
    [sourceId, key, JSON.stringify(policy), userId],
  );
  policyCache.clear();
}

/** Records who did what. Never blocks the request it describes. */
export async function audit(userId: number | null, action: string, target?: string | null, details?: Record<string, unknown>) {
  try {
    if (!(await accessReady())) return;
    await getAppDb().execute('INSERT INTO audit_log (user_id, action, target, details) VALUES (?, ?, ?, ?)', [userId, action, target ? String(target).slice(0, 255) : null, details ? JSON.stringify(details).slice(0, 60000) : null]);
  } catch (error) {
    console.error('[audit] could not record', action, error instanceof Error ? error.message : error);
  }
}
