import { CUBE_CATALOG, validateCubeQuery } from './cubeCatalog.mjs';

export function chartQueryForTool(tool, args = {}, requestedMetrics = []) {
  if (tool === 'query_semantic_layer') return args;
  const customer = tool === 'get_customer_list' || tool === 'get_active_customer_count';
  const ticket = tool.includes('ticket');
  const collection = tool.includes('tran_mode') || args.metric === 'total_collected';
  const financial = ['get_revenue_summary', 'get_pop_financials', 'get_package_financials', 'get_customer_financials', 'get_customer_financials_summary', 'get_revenue_timeseries_financials'].includes(tool);
  const cube = customer ? 'IspCustomer' : ticket ? 'IspTicket' : financial ? 'IspFinancial' : collection ? 'IspCollection' : 'IspBilling';
  const selected = requestedMetrics.find((m) => ['billed', 'collected', 'refunded', 'adjusted', 'outstanding'].includes(m)) || args.sortBy || 'billed';
  const financialMeasure = ['billed', 'collected', 'refunded', 'adjusted'].includes(selected) ? `total_${selected}` : selected === 'outstanding' ? 'outstanding' : 'total_billed';
  const measure = customer ? (tool === 'get_active_customer_count' ? 'active_customer_count' : 'customer_count') : ticket ? 'ticket_count' : financial ? financialMeasure : collection ? 'total_collected' : 'total_billed';
  const date = customer ? (args.dateField === 'activated' ? 'activated_date' : 'entry_date') : ticket ? 'opened_date' : 'ref_date';
  const filters = [];
  const add = (member, value, name) => {
    if (value == null || value === '') return;
    const match = { member, operator: 'equals', values: [String(value)] };
    filters.push(name ? { or: [match, { member: name, operator: 'equals', values: [String(value)] }] } : match);
  };
  add('IspCustomer.pop_id', args.popId, 'IspPop.pop_name');
  add('IspCustomer.package_id', args.packageId, 'IspPackage.package_name');
  add('IspCustomer.status_id', args.statusId, 'IspStatus.status_name');
  add('IspTicket.ticket_type_id', args.ticketTypeId, 'IspTicketType.ticket_type_name');
  add('IspTicket.department_id', args.departmentId);
  add('IspTicket.status', args.status);
  const dimension = customer ? 'IspPop.pop_name' : ticket ? 'IspTicketType.ticket_type_name' : tool.includes('package') ? 'IspPackage.package_name' : tool.includes('customer_financial') ? 'IspCustomer.customer_id' : collection && tool.includes('tran_mode') ? 'IspCollection.tran_mode_id' : financial ? 'IspFinancial.pop_id' : 'IspCustomer.pop_id';
  return { measures: [`${cube}.${measure}`], dimensions: [dimension], filters,
    timeDimensions: [{ dimension: `${cube}.${date}`, ...(args.dateFrom || args.dateTo ? { dateRange: [args.dateFrom || '1900-01-01', args.dateTo || new Date().toISOString().slice(0, 10)] } : {}) }] };
}

export function chartOptions(query) {
  validateCubeQuery(query);
  const root = (query.measures?.[0] || query.dimensions?.[0] || query.timeDimensions?.[0]?.dimension).split('.')[0];
  const reachable = new Set([root]);
  for (const name of reachable) for (const join of CUBE_CATALOG.find((c) => c.name === name)?.joins ?? []) reachable.add(join.name);
  const cubes = CUBE_CATALOG.filter((c) => reachable.has(c.name));
  const rootCube = CUBE_CATALOG.find((c) => c.name === root);
  return {
    measures: rootCube.measures,
    dimensions: cubes.flatMap((c) => c.dimensions).filter((d) => d.type !== 'time' && !d.primaryKey),
    times: cubes.flatMap((c) => c.dimensions).filter((d) => d.type === 'time'),
    defaultMeasure: query.measures?.[0] || rootCube.measures[0]?.name,
    defaultDimension: query.dimensions?.find((d) => cubes.some((c) => c.dimensions.some((m) => m.name === d && m.type !== 'time' && !m.primaryKey))) || cubes.flatMap((c) => c.dimensions).find((d) => d.type === 'string' && !d.primaryKey)?.name,
    defaultTime: query.timeDimensions?.[0]?.dimension || rootCube.dimensions.find((d) => d.type === 'time' && !d.name.endsWith('.source_synced_at'))?.name,
  };
}

export function buildChartQuery(source, config, linkedFilters = []) {
  const options = chartOptions(source);
  const measure = config.measure || options.defaultMeasure;
  const dimension = config.dimension || options.defaultDimension;
  const time = config.time || options.defaultTime;
  if (!options.measures.some((m) => m.name === measure)) throw new Error('Select a measure from this report\'s fact table.');
  if (!options.dimensions.some((d) => d.name === dimension)) throw new Error('Invalid chart category.');
  if (config.kind !== 'bar' && !options.times.some((d) => d.name === time)) throw new Error('This report has no suitable time field.');
  const filters = [...(source.filters ?? []), ...linkedFilters];
  if (config.search) filters.push({ member: dimension, operator: 'contains', values: [config.search] });
  const dimensions = config.kind === 'line' ? [] : [dimension];
  const timeDimensions = (source.timeDimensions ?? []).map((t) => ({ ...t, granularity: undefined }));
  if (config.kind !== 'bar') {
    const existing = timeDimensions.find((t) => t.dimension === time);
    if (existing) existing.granularity = config.granularity || 'month';
    else timeDimensions.push({ dimension: time, granularity: config.granularity || 'month' });
  }
  const order = config.kind === 'line' ? { [time]: 'asc' } : { [measure]: config.direction === 'asc' ? 'asc' : 'desc', [dimension]: 'asc' };
  return validateCubeQuery({ measures: [measure], dimensions, filters, timeDimensions, order });
}

export function endOfBucket(value, granularity = 'month') {
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid chart date bucket.');
  if (granularity === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (granularity === 'quarter') date.setUTCMonth(date.getUTCMonth() + 3);
  else if (granularity === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 7);
  else if (granularity === 'day') date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCHours(date.getUTCHours() + 1);
  return new Date(date.getTime() - 1).toISOString();
}
