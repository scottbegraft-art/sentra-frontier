/**
 * Deterministic warehouse-packing scenario calculator (Final Sprint).
 *
 * Pure arithmetic on USER-SUPPLIED inputs only. No model output, no
 * measured site data, and no invented measurements enter here. Every
 * result is a projection from the inputs, labeled as such — it is NOT
 * an observed result, and labor-hour value is NOT cash saved.
 */

export interface CalculatorInput {
  /** Current processing time per unit, minutes. Must be > 0. */
  currentMinutesPerUnit: number;
  /** Proposed processing time per unit, minutes. Must be > 0. */
  proposedMinutesPerUnit: number;
  /** Units processed per day. Must be > 0. */
  unitsPerDay: number;
  /** Labor cost per hour, USD. Must be >= 0. */
  laborCostPerHourUsd: number;
  /** Working days in the period. Must be > 0. */
  workingDays: number;
}

export interface CalculatorResult {
  inputs: CalculatorInput;
  /** current - proposed, minutes per unit (negative if the proposal is slower). */
  timeSavedPerUnitMinutes: number;
  /** Units per hour before and after. */
  unitsPerHourBefore: number;
  unitsPerHourAfter: number;
  /** (after - before) / before * 100. */
  productivityChangePercent: number;
  /** Units/day * saved minutes/unit / 60, hours per day. */
  timeSavedPerDayHours: number;
  /** Per-day hours * working days. */
  timeSavedPerPeriodHours: number;
  /** Period hours * labor cost/hour. Value of hours, NOT cash savings. */
  laborHourValueUsd: number;
  formulas: string[];
  assumptions: string[];
  disclaimer: string;
}

export function calculateImprovement(input: CalculatorInput): CalculatorResult {
  const { currentMinutesPerUnit, proposedMinutesPerUnit, unitsPerDay, laborCostPerHourUsd, workingDays } = input;
  const num = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a finite number.`);
    return v;
  };
  const cur = num(currentMinutesPerUnit, "currentMinutesPerUnit");
  const prop = num(proposedMinutesPerUnit, "proposedMinutesPerUnit");
  const units = num(unitsPerDay, "unitsPerDay");
  const labor = num(laborCostPerHourUsd, "laborCostPerHourUsd");
  const days = num(workingDays, "workingDays");
  if (cur <= 0) throw new Error("currentMinutesPerUnit must be greater than 0.");
  if (prop <= 0) throw new Error("proposedMinutesPerUnit must be greater than 0.");
  if (units <= 0) throw new Error("unitsPerDay must be greater than 0.");
  if (labor < 0) throw new Error("laborCostPerHourUsd must not be negative.");
  if (days <= 0) throw new Error("workingDays must be greater than 0.");

  const timeSavedPerUnitMinutes = cur - prop;
  const unitsPerHourBefore = 60 / cur;
  const unitsPerHourAfter = 60 / prop;
  const productivityChangePercent = ((unitsPerHourAfter - unitsPerHourBefore) / unitsPerHourBefore) * 100;
  const timeSavedPerDayHours = (units * timeSavedPerUnitMinutes) / 60;
  const timeSavedPerPeriodHours = timeSavedPerDayHours * days;
  const laborHourValueUsd = timeSavedPerPeriodHours * labor;

  return {
    inputs: input,
    timeSavedPerUnitMinutes,
    unitsPerHourBefore,
    unitsPerHourAfter,
    productivityChangePercent,
    timeSavedPerDayHours,
    timeSavedPerPeriodHours,
    laborHourValueUsd,
    formulas: [
      "time_saved_per_unit_minutes = current_minutes_per_unit - proposed_minutes_per_unit",
      "units_per_hour = 60 / minutes_per_unit",
      "productivity_change_percent = (units_per_hour_after - units_per_hour_before) / units_per_hour_before * 100",
      "time_saved_per_day_hours = units_per_day * time_saved_per_unit_minutes / 60",
      "time_saved_per_period_hours = time_saved_per_day_hours * working_days",
      "labor_hour_value_usd = time_saved_per_period_hours * labor_cost_per_hour_usd",
    ],
    assumptions: [
      "Inputs are user-supplied estimates, not measured site data.",
      "Processing time is assumed uniform across units; breaks, setup, and variability are not modeled.",
      "Units per day and working days are assumed constant across the period.",
      "Labor cost per hour is assumed constant; overhead, benefits, and overtime are not modeled.",
    ],
    disclaimer:
      "PROJECTION, NOT AN OBSERVED RESULT. These numbers show what WOULD happen if the proposed time per unit were achieved at the stated volume. Labor-hour value is the value of hours at the stated rate — it is NOT cash savings, because saved hours may be redeployed rather than eliminated, and no headcount, wage, or cost change is assumed.",
  };
}
