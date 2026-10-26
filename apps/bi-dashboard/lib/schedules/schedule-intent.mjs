// Understands schedule phrases typed in chat ("every Monday at 9am for last
// week") and the rolling date ranges a scheduled report re-runs with.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const DATE_RANGES = {
  none: 'Same as the report',
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 days',
  this_week: 'This week (from Monday)',
  last_week: 'Last week (Monday–Sunday)',
  this_month: 'This month',
  last_month: 'Last month',
  this_year: 'This year',
};

/**
 * Splits "/schedule customers per package every Monday at 9am for last week"
 * into the question and the schedule. Unrecognised parts stay in the question.
 */
export function parseScheduleText(input) {
  let text = ` ${String(input || '').replace(/^\s*\/schedule\b/i, '')} `;
  const take = (pattern) => { const match = text.match(pattern); if (match) text = text.replace(match[0], ' '); return match; };
  const schedule = { frequency: null, time: null };

  const time = take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || take(/\bat\s+(\d{1,2}):(\d{2})\b/i);
  if (time) {
    let hour = Number(time[1]) % 24; const minute = Number(time[2] || 0);
    if (time[3]) { const pm = /pm/i.test(time[3]); if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
    if (hour < 24 && minute < 60) schedule.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const weekday = take(new RegExp(`\\b(?:every|each|on|weekly on)\\s+(${WEEKDAYS.join('|')})s?\\b`, 'i'));
  const monthDay = take(/\b(?:monthly|every month|each month)(?:\s+on)?(?:\s+the)?(?:\s+day)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i) || take(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:every|each)\s+month)?\b/i);
  if (weekday) { schedule.frequency = 'weekly'; schedule.dayOfWeek = WEEKDAYS.indexOf(weekday[1].toLowerCase()); }
  else if (monthDay) { schedule.frequency = 'monthly'; schedule.dayOfMonth = Math.min(31, Math.max(1, Number(monthDay[1]))); }
  else if (take(/\b(?:monthly|every month|each month)\b/i)) { schedule.frequency = 'monthly'; schedule.dayOfMonth = 1; }
  else if (take(/\b(?:weekly|every week|each week)\b/i)) { schedule.frequency = 'weekly'; schedule.dayOfWeek = 1; }
  else if (take(/\b(?:daily|every day|each day|every morning|every evening)\b/i)) schedule.frequency = 'daily';

  let dateRange = null;
  const ranges = [
    [/\b(?:for\s+)?(?:the\s+)?(?:last|past|previous)\s+7\s+days\b/i, 'last_7_days'],
    [/\b(?:for\s+)?(?:the\s+)?(?:last|previous)\s+week\b/i, 'last_week'],
    [/\b(?:for\s+)?(?:the\s+)?(?:last|previous)\s+month\b/i, 'last_month'],
    [/\b(?:for\s+)?this\s+week\b/i, 'this_week'],
    [/\b(?:for\s+)?this\s+month\b/i, 'this_month'],
    [/\b(?:for\s+)?this\s+year\b/i, 'this_year'],
    [/\b(?:for\s+)?yesterday\b/i, 'yesterday'],
    [/\b(?:for\s+)?today\b/i, 'today'],
  ];
  for (const [pattern, preset] of ranges) if (take(pattern)) { dateRange = preset; break; }

  const question = text.replace(/\s+/g, ' ').replace(/\s*,\s*$/, '').replace(/\b(?:and\s+)?(?:schedule|run|send)\s+(?:it|this)?\s*$/i, '').trim();
  return { question, schedule, dateRange };
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => { const date = new Date(Date.UTC(y, m - 1, d)); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; };

/** Start (inclusive) and end (exclusive) dates of a rolling range, in a timezone. */
export function presetRange(preset, timezone = 'UTC', now = Date.now()) {
  if (!preset || preset === 'none' || !DATE_RANGES[preset]) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const y = Number(parts.year); const m = Number(parts.month); const d = Number(parts.day);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const monday = d - ((weekday + 6) % 7);
  switch (preset) {
    case 'today': return { start: iso(y, m, d), end: iso(y, m, d + 1) };
    case 'yesterday': return { start: iso(y, m, d - 1), end: iso(y, m, d) };
    case 'last_7_days': return { start: iso(y, m, d - 7), end: iso(y, m, d) };
    case 'this_week': return { start: iso(y, m, monday), end: iso(y, m, d + 1) };
    case 'last_week': return { start: iso(y, m, monday - 7), end: iso(y, m, monday) };
    case 'this_month': return { start: iso(y, m, 1), end: iso(y, m, d + 1) };
    case 'last_month': return { start: iso(y, m - 1, 1), end: iso(y, m, 1) };
    case 'this_year': return { start: iso(y, 1, 1), end: iso(y, m, d + 1) };
    default: return null;
  }
}
const dayBefore = (date) => { const [y, m, d] = date.split('-').map(Number); return iso(y, m, d - 1); };

/**
 * Moves a saved query's date filter to a new range. Existing date conditions
 * on the report get the new bounds; a report grouped by a date with no date
 * filter gets one. Reports with no date at all are left unchanged.
 */
export function applyRangeToQuery(query, range, isDateField) {
  if (!range || typeof query !== 'string') return query;
  const plan = JSON.parse(query);
  let changed = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.and || node.or) return { ...node, [node.and ? 'and' : 'or']: (node.and || node.or).map(visit) };
    if (node.not) return { not: visit(node.not) };
    if (!node.field || !isDateField(node.field)) return node;
    if (['gte', 'gt'].includes(node.operator)) { changed = true; return { ...node, operator: 'gte', value: range.start }; }
    if (['lt', 'lte'].includes(node.operator)) { changed = true; return { ...node, operator: 'lt', value: range.end }; }
    if (['between', 'eq'].includes(node.operator)) { changed = true; return { and: [{ field: node.field, operator: 'gte', value: range.start }, { field: node.field, operator: 'lt', value: range.end }] }; }
    return node;
  };
  if (plan.where) plan.where = visit(plan.where);
  if (!changed) {
    const field = plan.dateGroups?.[0]?.field || (plan.groupBy || []).find(isDateField) || (Array.isArray(plan.columns) ? plan.columns.find(isDateField) : undefined);
    if (!field) return query;
    const bounds = [{ field, operator: 'gte', value: range.start }, { field, operator: 'lt', value: range.end }];
    plan.where = plan.where ? { and: [plan.where, ...bounds] } : { and: bounds };
  }
  return JSON.stringify(plan);
}

/** Sets a procedure's start/end date parameters to a new range (end inclusive). */
export function applyRangeToProcedure(values, parameters, range) {
  if (!range) return values;
  const next = { ...values };
  for (const p of parameters || []) {
    if (p.output || !/^(date|datetime|datetime2|datetimeoffset|smalldatetime)$/i.test(p.baseType || p.type)) continue;
    if (/(start|from|begin|fdate)/i.test(p.name)) next[p.name] = range.start;
    else if (/(end|to\b|todate|tdate|_to$)/i.test(p.name)) next[p.name] = dayBefore(range.end);
  }
  return next;
}

/** Rolling dates are explicit inputs, not omitted procedure defaults. */
export function procedureRangeArguments(values, parameters, omitted = [], range) {
  const overrides = range ? applyRangeToProcedure({}, parameters, range) : {};
  return {
    values: { ...values, ...overrides },
    omitted: omitted.filter(name => !Object.hasOwn(overrides, name)),
  };
}
