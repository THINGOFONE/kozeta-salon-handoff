// Toronto (salon-local) timezone helpers.
// The server may run in any timezone (UTC on Fly.io/Replit), so business-hour
// windows must be computed explicitly in America/Toronto, never with setHours().

const TORONTO_TZ = 'America/Toronto';

// Offset (ms) between UTC and Toronto wall-clock at the given instant.
function torontoOffsetMs(date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TORONTO_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUTC - date.getTime();
}

// The hour of day (0-23) at the given instant, in Toronto wall-clock time.
export function torontoHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TORONTO_TZ, hour: 'numeric', hour12: false,
  }).format(date)) % 24;
}

// The calendar date (YYYY-MM-DD) at the given instant, in Toronto.
export function torontoDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// Returns the UTC instant corresponding to `hour`:00 Toronto time on the given
// calendar date. Accepts "YYYY-MM-DD" or a Date (whose Toronto calendar date is used).
// Two-pass offset correction handles DST transition days correctly.
export function torontoDateAtHour(dateInput: string | Date, hour: number): Date {
  let y: number, m: number, d: number;
  if (typeof dateInput === 'string') {
    const match = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) throw new Error(`torontoDateAtHour: invalid date string "${dateInput}"`);
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else {
    const [ys, ms, ds] = torontoDateString(dateInput).split('-');
    y = Number(ys); m = Number(ms); d = Number(ds);
  }
  const wallClockAsUTC = Date.UTC(y, m - 1, d, hour, 0, 0, 0);
  // First guess: assume the offset at the naive UTC instant, then re-check at the result.
  let offset = torontoOffsetMs(new Date(wallClockAsUTC));
  let result = new Date(wallClockAsUTC - offset);
  offset = torontoOffsetMs(result);
  result = new Date(wallClockAsUTC - offset);
  return result;
}
