// Roles decide what a person can DO; departments decide which ROWS they see.
// Roles are bundles of permissions; nothing in the app checks a role name
// directly, only permissions, so roles can be adjusted in one place.

export const PERMISSIONS = [
  'chat.use',          // ask questions, view own chats and reports
  'reports.save',      // save and share reports
  'reports.export',    // Excel / PDF exports
  'reports.schedule',  // scheduled reports, /schedule
  'procedures.run',    // stored procedure reports, /run
  'setup.manage',      // workspaces, connections, tool generation and approval
  'users.manage',      // users, roles, departments, data access rules
  'audit.view',        // audit log
  'data.all',          // every row of every database, no department filter
];

export const ROLES = {
  admin: { label: 'Admin', description: 'Runs the system: users, departments, data access, connections and tools. Sees no business data unless given a data role too.', permissions: ['setup.manage', 'users.manage', 'audit.view'] },
  ceo: { label: 'CEO', description: 'Sees all data in every department.', permissions: ['chat.use', 'reports.save', 'reports.export', 'reports.schedule', 'procedures.run', 'audit.view', 'data.all'] },
  manager: { label: 'Manager', description: 'Sees their departments (and departments under them).', permissions: ['chat.use', 'reports.save', 'reports.export', 'reports.schedule', 'procedures.run'] },
  executive: { label: 'Executive', description: 'Sees their department.', permissions: ['chat.use', 'reports.save', 'reports.export'] },
};
export const ROLE_NAMES = Object.keys(ROLES);
/** Roles that see business data (Admin alone does not). */
export const DATA_ROLES = ['ceo', 'manager', 'executive'];

/** Permissions granted by a set of roles; unknown roles grant nothing. */
export function permissionsFor(roles) {
  return [...new Set((roles || []).flatMap((role) => ROLES[role]?.permissions || []))];
}

/**
 * Departments a user covers: their own plus every department beneath them
 * in the tree. Managers use the whole subtree; Executives only their own.
 */
export function coveredDepartments(assigned, departments, includeChildren = true) {
  const children = new Map();
  for (const d of departments) {
    if (d.parentId == null) continue;
    if (!children.has(d.parentId)) children.set(d.parentId, []);
    children.get(d.parentId).push(d.id);
  }
  const result = new Set();
  const visit = (id, depth) => {
    if (result.has(id) || depth > 20) return;
    result.add(id);
    if (includeChildren) for (const child of children.get(id) || []) visit(child, depth + 1);
  };
  for (const id of assigned || []) visit(Number(id), 0);
  return [...result];
}

/** True when the role list is valid: known roles, at least one, no duplicates. */
export function validRoles(roles) {
  return Array.isArray(roles) && roles.length > 0 && roles.length <= ROLE_NAMES.length
    && new Set(roles).size === roles.length && roles.every((role) => ROLE_NAMES.includes(role));
}
