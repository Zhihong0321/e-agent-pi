// Timing rule parser, validator, and occurrence generator for Scheduler AI.
// Handles timezones, all-day calendar dates, timed events, and recurrence preview.

export const DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";
import { CronExpressionParser } from 'cron-parser';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * Validate IANA timezone. Defaults to Asia/Kuala_Lumpur if omitted or invalid.
 */
export function validateTimezone(tz) {
  if (!tz || typeof tz !== "string") return DEFAULT_TIMEZONE;
  const clean = tz.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: clean }).format();
    return clean;
  } catch {
    throw new Error(`Invalid IANA timezone: "${tz}"`);
  }
}

/**
 * Format a Date in a specific timezone as YYYY-MM-DD HH:mm:ss.
 */
export function formatInTimezone(date, timezone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * Get date string (YYYY-MM-DD) in a specific timezone.
 */
export function dateInTimezone(date, timezone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

/**
 * Given a local date (YYYY-MM-DD) and optional local time (HH:mm) in a timezone,
 * convert to a UTC Date object.
 */
export function localToUtc(dateStr, timeStr = "00:00:00", timezone = DEFAULT_TIMEZONE) {
  if (!ISO_DATE.test(dateStr)) throw new Error(`Invalid date format (must be YYYY-MM-DD): ${dateStr}`);
  const [year, month, day] = dateStr.split("-").map(Number);
  const timeMatch = timeStr.match(TIME_REGEX);
  if (!timeMatch) throw new Error(`Invalid time format (must be HH:mm or HH:mm:ss): ${timeStr}`);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || 0);

  // Guess UTC based on nominal parts
  let utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Determine timezone offset difference at this instant
  const partsAt = date => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  for (let i = 0; i < 3; i++) {
    const p = partsAt(utcGuess);
    const local = Date.UTC(Number(p.year), Number(p.month)-1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    utcGuess = new Date(utcGuess.getTime() + Date.UTC(year,month-1,day,hour,minute,second) - local);
  }
  const p = partsAt(utcGuess);
  if (`${p.year}-${p.month}-${p.day}` !== dateStr || Number(p.hour) !== hour || Number(p.minute) !== minute) throw new Error('Invalid date or nonexistent local time');
  return utcGuess;
}

/**
 * Validate and normalize a timing rule.
 */
export function validateTimingRule(rule = {}, timezone = DEFAULT_TIMEZONE) {
  if (!rule || typeof rule !== "object") throw new Error("Timing rule must be an object");
  for (const key of ['startDate','endDate']) if (rule[key]) localToUtc(rule[key], '12:00', timezone);
  if (rule.startDate && rule.endDate && rule.startDate > rule.endDate) throw new Error('End date must follow start date');
  const kind = rule.kind || (rule.date ? "date" : "timed");
  if (kind === 'cron') {
    const expression = String(rule.expression || '').trim();
    if (expression.split(/\s+/).length !== 5 || /[?L#]/.test(expression)) throw new Error('Use a standard five-field cron expression (minute hour day month weekday)');
    CronExpressionParser.parse(expression, { tz: timezone });
    return { kind, expression, startDate: rule.startDate || null, endDate: rule.endDate || null };
  }

  if (kind === "date") {
    if (!rule.date || !ISO_DATE.test(rule.date)) throw new Error("Timing rule 'date' must be in YYYY-MM-DD format");
    return {
      kind: "date",
      date: rule.date,
      all_day: rule.all_day !== false,
      time: rule.time && TIME_REGEX.test(rule.time) ? rule.time.slice(0, 5) : null,
    };
  }

  if (kind === "timed") {
    if (!rule.date || !ISO_DATE.test(rule.date)) throw new Error("Timing rule 'timed' requires date in YYYY-MM-DD format");
    if (!rule.time || !TIME_REGEX.test(rule.time)) throw new Error("Timing rule 'timed' requires time in HH:mm format");
    return {
      kind: "timed",
      date: rule.date,
      time: rule.time.slice(0, 5),
      all_day: false,
    };
  }

  if (kind === "daily") {
    if (!rule.time || !TIME_REGEX.test(rule.time)) throw new Error("Daily timing requires time in HH:mm format");
    return {
      kind: "daily",
      time: rule.time.slice(0, 5),
      startDate: rule.startDate && ISO_DATE.test(rule.startDate) ? rule.startDate : null,
      endDate: rule.endDate && ISO_DATE.test(rule.endDate) ? rule.endDate : null,
    };
  }

  if (kind === "weekly") {
    if (!rule.time || !TIME_REGEX.test(rule.time)) throw new Error("Weekly timing requires time in HH:mm format");
    const days = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0 ? rule.daysOfWeek : [1]; // 1 = Monday
    if (days.some(day => !Number.isInteger(day) || day < 0 || day > 7)) throw new Error('Weekdays must be integers from 0 to 7');
    return {
      kind: "weekly",
      time: rule.time.slice(0, 5),
      daysOfWeek: days,
      startDate: rule.startDate && ISO_DATE.test(rule.startDate) ? rule.startDate : null,
      endDate: rule.endDate && ISO_DATE.test(rule.endDate) ? rule.endDate : null,
    };
  }

  if (kind === "monthly") {
    if (!rule.time || !TIME_REGEX.test(rule.time)) throw new Error("Monthly timing requires time in HH:mm format");
    const day = Number(rule.dayOfMonth) || 1;
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("Monthly dayOfMonth must be between 1 and 31");
    return {
      kind: "monthly",
      time: rule.time.slice(0, 5),
      dayOfMonth: day,
      startDate: rule.startDate && ISO_DATE.test(rule.startDate) ? rule.startDate : null,
      endDate: rule.endDate && ISO_DATE.test(rule.endDate) ? rule.endDate : null,
    };
  }

  throw new Error(`Unsupported timing kind: ${kind}`);
}

/**
 * Preview interpreted timing rule and compute next occurrences (up to count).
 */
export function computeOccurrences(rule, timezone = DEFAULT_TIMEZONE, count = 3, from = new Date()) {
  const normTz = validateTimezone(timezone);
  const normRule = validateTimingRule(rule, normTz);
  const occurrences = [];

  if (normRule.kind === "date") {
    const timeStr = normRule.time || "09:00:00";
    const utcDate = localToUtc(normRule.date, timeStr, normTz);
    occurrences.push({
      nominalDueAt: utcDate.toISOString(),
      localFormatted: `${normRule.date}${normRule.all_day ? " (All day)" : ` ${timeStr.slice(0, 5)}`}`,
      date: normRule.date,
      allDay: normRule.all_day,
    });
    return occurrences;
  }

  if (normRule.kind === "timed") {
    const utcDate = localToUtc(normRule.date, `${normRule.time}:00`, normTz);
    occurrences.push({
      nominalDueAt: utcDate.toISOString(),
      localFormatted: `${normRule.date} ${normRule.time} (${normTz})`,
      date: normRule.date,
      allDay: false,
    });
    return occurrences;
  }

  // Use the same timezone-aware parser for cron and daily/weekly/monthly rules.
  const expression = normRule.kind === 'cron' ? normRule.expression
    : normRule.kind === 'daily' ? `${Number(normRule.time.slice(3))} ${Number(normRule.time.slice(0,2))} * * *`
    : normRule.kind === 'weekly' ? `${Number(normRule.time.slice(3))} ${Number(normRule.time.slice(0,2))} * * ${normRule.daysOfWeek.join(',')}`
    : `${Number(normRule.time.slice(3))} ${Number(normRule.time.slice(0,2))} ${normRule.dayOfMonth} * *`;
  const start = normRule.startDate ? localToUtc(normRule.startDate, '00:00', normTz) : from;
  const end = normRule.endDate ? localToUtc(normRule.endDate, '23:59:59', normTz) : null;
  const currentDate = new Date(Math.max(from.getTime(), start.getTime() - 1));
  if (end && currentDate >= end) return [];
  const interval = CronExpressionParser.parse(expression, { tz: normTz, currentDate, ...(end ? { endDate: end } : {}) });
  while (occurrences.length < Math.min(count, 100) && interval.hasNext()) {
    const date = interval.next().toDate();
    occurrences.push({ nominalDueAt: date.toISOString(), localFormatted: `${formatInTimezone(date, normTz)} (${normTz})`, date: dateInTimezone(date, normTz), allDay: false });
  }
  return occurrences;
}
