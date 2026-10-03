import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, daysBetween, isValidIsoDay, resolveRelativeDate } from './dates.js';

// 2026-10-01 is a Thursday.
const TODAY = '2026-10-01';

describe('isValidIsoDay', () => {
  it('accepts real dates and rejects impossible or badly formatted ones', () => {
    assert.equal(isValidIsoDay('2026-10-01'), true);
    assert.equal(isValidIsoDay('2028-02-29'), true);
    assert.equal(isValidIsoDay('2026-02-29'), false);
    assert.equal(isValidIsoDay('2026-02-30'), false);
    assert.equal(isValidIsoDay('2026-13-01'), false);
    assert.equal(isValidIsoDay('1/10/2026'), false);
  });
});

describe('addDays / daysBetween', () => {
  it('crosses month and year boundaries', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  });
  it('counts whole days in either direction', () => {
    assert.equal(daysBetween('2026-10-01', '2026-10-09'), 8);
    assert.equal(daysBetween('2026-10-09', '2026-10-01'), -8);
    assert.equal(daysBetween('2026-10-01', '2026-10-01'), 0);
  });
});

describe('resolveRelativeDate', () => {
  const cases: [string, string | null][] = [
    ['by Friday', '2026-10-02'],
    ['Fri', '2026-10-02'],
    ['next Friday', '2026-10-09'],
    ['by Thursday', '2026-10-01'], // today is Thursday
    ['Monday please', '2026-10-05'],
    ['today', TODAY],
    ['ASAP', TODAY],
    ['tomorrow', '2026-10-02'],
    ['the day after tomorrow', '2026-10-03'],
    ['in 3 days', '2026-10-04'],
    ['in two weeks', '2026-10-15'],
    ['next week', '2026-10-08'],
    ['for the weekend', '2026-10-03'],
    ['by 2026-10-20', '2026-10-20'],
    ['sometime soon', null],
    ['for my sister’s party', null],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" -> ${expected}`, () => {
      assert.equal(resolveRelativeDate(text, TODAY), expected);
    });
  }

  it('"next <day>" means that day in next calendar week', () => {
    // Friday 2 Oct: next week runs Mon 5 - Sun 11.
    assert.equal(resolveRelativeDate('next Tuesday', '2026-10-02'), '2026-10-06');
    assert.equal(resolveRelativeDate('next Friday', '2026-10-02'), '2026-10-09');
    // Sunday 4 Oct: next week still starts Mon 5.
    assert.equal(resolveRelativeDate('next Monday', '2026-10-04'), '2026-10-05');
    // Monday 5 Oct: next week starts Mon 12.
    assert.equal(resolveRelativeDate('next Monday', '2026-10-05'), '2026-10-12');
    assert.equal(resolveRelativeDate('next Sunday', '2026-10-05'), '2026-10-18');
  });
});
