/*
 * rules.js — business rules and analytical thresholds, each tagged with where it comes from.
 *
 *   source: 'product'   verified in the HW Release Schedule/Clock code (file reference in `ref`)
 *           'data'      inferred from the dataset itself at run time (value filled in by the engine)
 *           'analysis'  analytical assumption introduced for labor optimisation — needs business validation
 *
 * A dataset manifest entry may override any value via "rules": { key: value }.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});

  const DEFAULTS = {
    punchTolerance: {
      value: 10, unit: 'min', source: 'product',
      label: 'On-schedule punch tolerance',
      ref: 'EOCustomer.properties:30-37 (minsOffsetForEarlyClockIn / LateClockOut = 10); EOTdyEmpPunDetail.java:1698-1763',
      use: 'Minutes before scheduled start / after scheduled end that still count as on-schedule. Only minutes beyond this are treated as avoidable.',
    },
    punchViolation: {
      value: 20, unit: 'min', source: 'product',
      label: 'Start/End-of-shift violation threshold',
      ref: 'EOCustomer.properties (…NoViolation = 20); EOTdyEmpPunDetail.java:1742-1766',
      use: 'Early clock-in or late clock-out beyond this is a schedule-adherence violation (VIOL_SCHEDULE).',
    },
    otMultiplier: {
      value: 1.5, unit: '× rate', source: 'product', label: 'Overtime pay multiplier',
      ref: 'EOTdyEmpPunDetail.java:2656-2661', use: 'Fallback only — OT premium is taken from actual OT pay when the export provides it.',
    },
    weeklyOtThreshold: {
      value: 2400, unit: 'min/week', source: 'data', label: 'Weekly overtime threshold',
      ref: 'Per-site setting in product (EOSiteWeekDetail weeklyHrsPriorToOT, no hard-coded default). Inferred from paid OT in the punch export.',
      use: 'Splits overtime into hours that were already in the schedule vs hours added by working beyond the schedule.',
    },
    autoClosePunch: {
      value: 840, unit: 'min', source: 'product', label: 'Open-punch auto-close',
      ref: 'closePunIfEmpClockExceedsXMins = 840 (14 h)',
      use: 'Punches at or above this length are treated as probable forgotten clock-outs.',
    },
    mealUnpaid: {
      value: true, unit: '', source: 'product', label: 'Meal breaks unpaid, rest breaks paid',
      ref: 'ZCBreakType.java; EOSchShiftBreak.java:45; EOEmpShift.java:819-830',
      use: 'Scheduled MEAL segments are subtracted from scheduled paid time; REST segments are not.',
    },
    mealRequiredAfter: {
      value: 360, unit: 'min', source: 'analysis', label: 'Shift length that should include a meal break',
      ref: 'Client-configured in product (mealBrkLength, default 0). 6 h used as a common policy reference — confirm against the state rules that apply.',
      use: 'Paid shifts longer than this with no meal break recorded are flagged as a compliance risk (no $ assigned).',
    },
    minMealLength: {
      value: 30, unit: 'min', source: 'analysis', label: 'Minimum meal break length',
      ref: 'Client-configured in product (mealBrkEarlyEndMins). 30 min used as policy reference.',
      use: 'Meal breaks shorter than this are flagged as short.',
    },
    minorAge: {
      value: 18, unit: 'years', source: 'analysis', label: 'Minor age', ref: 'Standard definition; product uses minorLbrLawGroup per age group.',
      use: 'Employees younger than this on the punch record are treated as minors for the flag-consistency check.',
    },
    minorLateHour: {
      value: 22 * 60, unit: 'min of day', source: 'analysis', label: 'Late-night limit for minors',
      ref: 'Common state limit (varies by state and school week).', use: 'Minor punches ending after this time are flagged for review.',
    },
    recurringWeeks: {
      value: 4, unit: 'weeks', source: 'analysis', label: 'Recurring behaviour threshold',
      ref: 'Analytical choice.', use: 'An employee pattern is "recurring" when it appears in at least this many distinct weeks.',
    },
    persistentMonths: {
      value: 5, unit: 'months', source: 'analysis', label: 'Persistent store threshold',
      ref: 'Analytical choice.', use: 'A store is "persistent" for an issue when it ranks in the top quartile in at least this many months.',
    },
    retroLag: {
      value: 60, unit: 'min', source: 'analysis', label: 'Retroactive manual entry lag',
      ref: 'Analytical choice.', use: 'A manual punch keyed in more than this long after the punch time is treated as reconstructed, not live.',
    },
    biometricMinShare: {
      value: 0.02, unit: 'share', source: 'analysis', label: 'Minimum biometric share for comparison',
      ref: 'Analytical choice.', use: 'Biometric vs non-biometric comparison is only reported when biometric punches reach this share and 200 events.',
    },
  };

  function build(overrides) {
    const r = {};
    for (const k in DEFAULTS) r[k] = Object.assign({}, DEFAULTS[k]);
    if (overrides) for (const k in overrides) if (r[k]) { r[k].value = overrides[k]; r[k].overridden = true; }
    return r;
  }

  LCI.rules = { DEFAULTS, build };
})(typeof globalThis !== 'undefined' ? globalThis : self);
