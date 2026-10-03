/**
 * Business-date helpers. All dates are local calendar days as 'YYYY-MM-DD' strings, which compare
 * correctly as strings and avoid timezone surprises.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');
const format = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export function isValidIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  return format(parse(value)) === value; // rejects 2026-02-30 etc.
}

export function todayIso(now = new Date()): string {
  return format(now);
}

export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setDate(d.getDate() + n);
  return format(d);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(day: string): number {
  return parse(day).getDay();
}

export function weekdayName(day: string): string {
  return parse(day).toLocaleDateString('en-GB', { weekday: 'long' });
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  ten: 10,
  fourteen: 14,
};

/**
 * Deterministically resolve common relative deadline phrases ("by Friday", "tomorrow",
 * "in 3 days", "next week", "2026-10-09"). Returns null when the phrase isn't understood,
 * so the caller can fall back to the model's interpretation.
 *
 * "Friday" means the next Friday on or after today; "next Friday" means the Friday of next
 * calendar week (Mon-Sun). Said on a Friday, "next Tuesday" is therefore 4 days away.
 */
export function resolveRelativeDate(text: string, today: string): string | null {
  const t = text.toLowerCase().trim();

  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && isValidIsoDay(iso[1]!)) return iso[1]!;

  if (/\b(today|tonight|asap|right away)\b/.test(t)) return today;
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);

  const inDays = t.match(/\bin\s+(\d+|[a-z]+)\s+(day|days|week|weeks)\b/);
  if (inDays) {
    const n = /^\d+$/.test(inDays[1]!) ? Number(inDays[1]) : NUMBER_WORDS[inDays[1]!];
    if (n !== undefined) return addDays(today, inDays[2]!.startsWith('week') ? n * 7 : n);
  }
  if (/\b(next week)\b/.test(t)) return addDays(today, 7);
  if (/\b(end of (the )?week|this weekend|the weekend|weekend)\b/.test(t)) {
    return nextWeekday(today, 6, false); // Saturday
  }

  const names = [...WEEKDAYS, ...Object.keys(WEEKDAY_ALIASES)].join('|');
  const wd = t.match(new RegExp(`\\b(next\\s+)?(${names})\\b`));
  if (wd) {
    const name = wd[2]!;
    const target = WEEKDAYS.includes(name) ? WEEKDAYS.indexOf(name) : WEEKDAY_ALIASES[name]!;
    return nextWeekday(today, target, Boolean(wd[1]));
  }
  return null;
}

function nextWeekday(today: string, target: number, nextWeek: boolean): string {
  if (!nextWeek) return addDays(today, (target - dayOfWeek(today) + 7) % 7);
  const daysToNextMonday = (8 - dayOfWeek(today)) % 7 || 7;
  const offsetFromMonday = (target + 6) % 7; // Mon=0 ... Sun=6
  return addDays(today, daysToNextMonday + offsetFromMonday);
}
