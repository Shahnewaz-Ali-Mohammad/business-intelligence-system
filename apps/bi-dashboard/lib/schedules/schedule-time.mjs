// Report schedules: when a saved report should next run, in the user's
// own timezone (daily, weekly on a weekday, or monthly on a day of month).

const FREQUENCIES = ['daily', 'weekly', 'monthly'];

/** Validates a schedule from the client; returns a clean copy or throws. */
export function cleanSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid schedule.');
  const frequency = String(input.frequency);
  if (!FREQUENCIES.includes(frequency)) throw new Error('Choose daily, weekly or monthly.');
  const time = String(input.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a time (HH:MM).');
  const timezone = String(input.timezone || 'UTC');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new Error('Unknown timezone.'); }
  const schedule = { enabled: input.enabled !== false, frequency, time, timezone };
  if (input.dateRange != null && input.dateRange !== 'none') {
    if (!['today', 'yesterday', 'last_7_days', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year'].includes(String(input.dateRange))) throw new Error('Unknown date range.');
    schedule.dateRange = String(input.dateRange);
  } else schedule.dateRange = 'none';
  if (frequency === 'weekly') {
    const day = Number(input.dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('Choose a weekday.');
    schedule.dayOfWeek = day;
  }
  if (frequency === 'monthly') {
    const day = Number(input.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Choose a day of the month (1–31).');
    schedule.dayOfMonth = day;
  }
  return schedule;
}

function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}
/** UTC milliseconds for a wall-clock time in a timezone. */
function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms) => { const w = wallClock(ms, timeZone); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms; };
  let result = guess - offsetAt(guess);
  result = guess - offsetAt(result);
  return result;
}
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The first scheduled moment strictly after `afterMs`. */
export function nextRunAt(schedule, afterMs = Date.now()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const start = wallClock(afterMs, schedule.timezone);
  for (let offset = 0; offset < 400; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = date.getUTCFullYear(); const month = date.getUTCMonth() + 1; const day = date.getUTCDate();
    if (schedule.frequency === 'weekly' && date.getUTCDay() !== schedule.dayOfWeek) continue;
    // A monthly day beyond the month's length (e.g. 31) runs on its last day.
    if (schedule.frequency === 'monthly' && day !== Math.min(schedule.dayOfMonth, daysInMonth(year, month))) continue;
    const at = zonedToUtc(year, month, day, hour, minute, schedule.timezone);
    if (at > afterMs) return at;
  }
  throw new Error('Could not compute the next run.');
}

/** Short human description, e.g. "Every Monday at 08:00 (Asia/Dhaka)". */
export function describeSchedule(schedule) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const when = schedule.frequency === 'daily' ? 'Every day' : schedule.frequency === 'weekly' ? `Every ${days[schedule.dayOfWeek]}` : `Monthly on day ${schedule.dayOfMonth}`;
  const ranges = { today: 'today', yesterday: 'yesterday', last_7_days: 'the last 7 days', this_week: 'this week', last_week: 'last week', this_month: 'this month', last_month: 'last month', this_year: 'this year' };
  return `${when} at ${schedule.time} (${schedule.timezone})${ranges[schedule.dateRange] ? `, for ${ranges[schedule.dateRange]}` : ''}`;
}
