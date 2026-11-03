import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateImprovement } from "./calculator.js";

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("deterministic calculator (Final Sprint)", () => {
  it("known case: 10 → 8 min/unit, 100/day, $20/hr, 20 days", () => {
    const r = calculateImprovement({
      currentMinutesPerUnit: 10,
      proposedMinutesPerUnit: 8,
      unitsPerDay: 100,
      laborCostPerHourUsd: 20,
      workingDays: 20,
    });
    assert.equal(r.timeSavedPerUnitMinutes, 2);
    assert.ok(approx(r.unitsPerHourBefore, 6));
    assert.ok(approx(r.unitsPerHourAfter, 7.5));
    assert.ok(approx(r.productivityChangePercent, 25));
    assert.ok(approx(r.timeSavedPerDayHours, 200 / 60));
    assert.ok(approx(r.timeSavedPerPeriodHours, (200 / 60) * 20));
    assert.ok(approx(r.laborHourValueUsd, ((200 / 60) * 20) * 20));
    assert.equal(r.formulas.length, 6);
    assert.match(r.disclaimer, /NOT cash savings/);
    assert.match(r.disclaimer, /PROJECTION/);
  });

  it("no change yields zero savings and zero productivity change", () => {
    const r = calculateImprovement({
      currentMinutesPerUnit: 5,
      proposedMinutesPerUnit: 5,
      unitsPerDay: 50,
      laborCostPerHourUsd: 25,
      workingDays: 10,
    });
    assert.equal(r.timeSavedPerUnitMinutes, 0);
    assert.equal(r.productivityChangePercent, 0);
    assert.equal(r.laborHourValueUsd, 0);
  });

  it("rejects non-positive times, units, and days, and negative labor cost", () => {
    const base = {
      currentMinutesPerUnit: 10,
      proposedMinutesPerUnit: 8,
      unitsPerDay: 100,
      laborCostPerHourUsd: 20,
      workingDays: 20,
    };
    assert.throws(() => calculateImprovement({ ...base, currentMinutesPerUnit: 0 }));
    assert.throws(() => calculateImprovement({ ...base, proposedMinutesPerUnit: -1 }));
    assert.throws(() => calculateImprovement({ ...base, unitsPerDay: 0 }));
    assert.throws(() => calculateImprovement({ ...base, workingDays: 0 }));
    assert.throws(() => calculateImprovement({ ...base, laborCostPerHourUsd: -5 }));
    assert.throws(() => calculateImprovement({ ...base, currentMinutesPerUnit: Number.NaN }));
  });
});
