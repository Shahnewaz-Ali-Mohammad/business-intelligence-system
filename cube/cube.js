const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const PostgresDriver = require('@cubejs-backend/postgres-driver');

async function workspaceConfig(securityContext) {
  const { iat: _iat, exp: _exp, ...claims } = securityContext;
  const token = jwt.sign({ ...claims, purpose: 'bridge' }, process.env.CUBEJS_API_SECRET, { algorithm: 'HS256', expiresIn: '60s' });
  const response = await fetch(process.env.WORKSPACE_BRIDGE_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Warehouse authorization or connection is no longer valid.');
  return response.json();
}
function legacyFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? legacyFiles(path.join(dir, entry.name)) : /\.ya?ml$/.test(entry.name) ? [{ fileName: path.relative('/cube/conf/model', path.join(dir, entry.name)), content: fs.readFileSync(path.join(dir, entry.name), 'utf8') }] : []);
}
const contextId = ({ securityContext }) => securityContext?.workspaceId ? `warehouse_${securityContext.workspaceId}_${securityContext.modelVersion}_${securityContext.preview ? 'preview' : 'live'}` : 'legacy_isp';
module.exports = {
  // Single Cube instance, no rollups. Configure Cube Store before scaling
  // this deployment across multiple instances or enabling pre-aggregations.
  cacheAndQueueDriver: 'memory',
  checkAuth: async (req, token) => { req.securityContext = jwt.verify(token, process.env.CUBEJS_API_SECRET, { algorithms: ['HS256'] }); },
  contextToAppId: contextId,
  contextToOrchestratorId: contextId,
  scheduledRefreshTimer: false,
  scheduledRefreshContexts: async () => [{ securityContext: {} }],
  repositoryFactory: ({ securityContext }) => ({
    localPath: () => '/cube/conf/model',
    dataSchemaFiles: async () => securityContext?.workspaceId ? [{ fileName: 'warehouse.yml', content: (await workspaceConfig(securityContext)).yaml }] : legacyFiles('/cube/conf/model'),
  }),
  driverFactory: async ({ securityContext }) => {
    if (!securityContext?.workspaceId) return new PostgresDriver();
    const { connection } = await workspaceConfig(securityContext);
    // "localhost" in a browser connection means the dashboard host, not
    // the Cube container. Remote hosts remain unchanged.
    if (['localhost', '127.0.0.1'].includes(connection.host)) connection.host = 'host.docker.internal';
    return new PostgresDriver({ ...connection, options: '-c default_transaction_read_only=on', readOnly: true, executionTimeout: 60, maxPoolSize: 3 });
  },
  queryRewrite: async (query, { securityContext }) => { if (securityContext?.workspaceId) await workspaceConfig(securityContext); return query; },
};
