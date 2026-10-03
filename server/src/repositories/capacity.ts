import type { CapacityDayDto } from '@sbom/shared';
import { type Db, query } from '../db/client.js';
import { conflict } from '../lib/errors.js';

interface CapacityRow {
  day: string;
  capacity_minutes: number;
  booked_minutes: number;
}

const toDto = (r: CapacityRow): CapacityDayDto => ({
  day: r.day,
  capacityMinutes: r.capacity_minutes,
  bookedMinutes: r.booked_minutes,
  freeMinutes: r.capacity_minutes - r.booked_minutes,
});

/** Capacity for each day in [from, to], both 'YYYY-MM-DD' and inclusive. */
export async function listCapacity(from: string, to: string, db?: Db): Promise<CapacityDayDto[]> {
  const rows = await query<CapacityRow>(
    'SELECT * FROM production_capacity WHERE day BETWEEN $1 AND $2 ORDER BY day',
    [from, to],
    db,
  );
  return rows.map(toDto);
}

/** Book production minutes on a day; fails if the day doesn't have enough free time. */
export async function bookCapacity(day: string, minutes: number, db?: Db): Promise<void> {
  const rows = await query(
    `UPDATE production_capacity SET booked_minutes = booked_minutes + $2
     WHERE day = $1 AND booked_minutes + $2 <= capacity_minutes
     RETURNING day`,
    [day, minutes],
    db,
  );
  if (rows.length === 0)
    throw conflict(`Not enough production capacity on ${day}`, { day, minutes });
}

export async function releaseCapacity(day: string, minutes: number, db?: Db): Promise<void> {
  await query(
    `UPDATE production_capacity SET booked_minutes = GREATEST(booked_minutes - $2, 0)
     WHERE day = $1`,
    [day, minutes],
    db,
  );
}
