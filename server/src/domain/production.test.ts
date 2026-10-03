import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CapacityDay, estimateCompletion, planProduction } from './production.js';

// Thu 1 Oct 2026 onwards: weekdays 240 min, Saturday 120, Sunday closed.
const DAYS: CapacityDay[] = [
  { day: '2026-10-01', capacityMinutes: 240, bookedMinutes: 200 }, // Thu, 40 free
  { day: '2026-10-02', capacityMinutes: 240, bookedMinutes: 0 }, // Fri
  { day: '2026-10-03', capacityMinutes: 120, bookedMinutes: 0 }, // Sat
  { day: '2026-10-04', capacityMinutes: 0, bookedMinutes: 0 }, // Sun
  { day: '2026-10-05', capacityMinutes: 240, bookedMinutes: 240 }, // Mon, full
  { day: '2026-10-06', capacityMinutes: 240, bookedMinutes: 0 }, // Tue
];

describe('planProduction', () => {
  it('fits small jobs into the first free time', () => {
    const p = planProduction(20, DAYS, '2026-10-01');
    assert.deepEqual(p.schedule, [{ day: '2026-10-01', minutes: 20 }]);
    assert.equal(p.completionDay, '2026-10-01');
  });

  it('splits work across days and skips closed or fully booked days', () => {
    const p = planProduction(40 + 240 + 120 + 100, DAYS, '2026-10-01');
    assert.deepEqual(p.schedule, [
      { day: '2026-10-01', minutes: 40 },
      { day: '2026-10-02', minutes: 240 },
      { day: '2026-10-03', minutes: 120 },
      { day: '2026-10-06', minutes: 100 },
    ]);
    assert.equal(p.completionDay, '2026-10-06');
  });

  it('reports whether the deadline is met, and the free time before it', () => {
    const ok = planProduction(200, DAYS, '2026-10-01', '2026-10-02');
    assert.equal(ok.meetsDeadline, true);
    assert.equal(ok.freeMinutesInWindow, 280);

    const late = planProduction(300, DAYS, '2026-10-01', '2026-10-02');
    assert.equal(late.meetsDeadline, false);
    assert.equal(late.completionDay, '2026-10-03');
  });

  it('flags work that does not fit in the known capacity', () => {
    const p = planProduction(10_000, DAYS, '2026-10-01');
    assert.equal(p.fitsInHorizon, false);
    assert.equal(p.completionDay, null);
    assert.deepEqual(p.schedule, []);
  });

  it('needs no schedule when nothing must be produced', () => {
    const p = planProduction(0, DAYS, '2026-10-01', '2026-10-02');
    assert.equal(p.completionDay, '2026-10-01');
    assert.equal(p.meetsDeadline, true);
  });

  it('ignores days before the start day and accepts unsorted input', () => {
    const p = planProduction(50, [...DAYS].reverse(), '2026-10-02');
    assert.deepEqual(p.schedule, [{ day: '2026-10-02', minutes: 50 }]);
  });
});

describe('estimateCompletion', () => {
  it('summarises a job that meets the deadline', () => {
    const e = estimateCompletion(20, DAYS, '2026-10-01', '2026-10-02');
    assert.equal(e.estimatedCompletionDate, '2026-10-01');
    assert.equal(e.meetsDeadline, true);
    assert.equal(e.slackDays, 1);
    assert.match(e.summary, /meets the 2026-10-02 deadline/);
  });

  it('summarises a missed deadline with how late it is', () => {
    const e = estimateCompletion(450, DAYS, '2026-10-01', '2026-10-02');
    assert.equal(e.meetsDeadline, false);
    assert.equal(e.estimatedCompletionDate, '2026-10-06');
    assert.equal(e.slackDays, -4);
    assert.match(e.summary, /misses the 2026-10-02 deadline by 4 day/);
  });

  it('stock-only orders are ready today', () => {
    const e = estimateCompletion(0, DAYS, '2026-10-01', null);
    assert.equal(e.needsProduction, false);
    assert.equal(e.estimatedCompletionDate, '2026-10-01');
    assert.equal(e.meetsDeadline, null);
  });
});
