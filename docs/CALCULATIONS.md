# Calculations, rules and assumptions

Every calculation in the portal falls into one of three classes, and the UI (Method & rules) shows which one each rule belongs to:

| Class | Meaning |
|---|---|
| **Product rule** | Verified in the HW Release Schedule / Clock code (file references below) |
| **From data** | Inferred from the loaded dataset at run time, then checked against it |
| **Analysis assumption** | Introduced for labor optimisation; needs business validation. Can be overridden per dataset in `datasets/manifest.json → rules` |

---

## 1. Keys, periods and exclusions

- **Employee key: GEID only.** Every employee-level join (schedule ↔ punch ↔ break ↔ edit ↔ exception) uses GEID.
  - Names are display-only. If one GEID carries several names, that is reported. If one name is used by several GEIDs, those are reported and never merged.
  - Rows without a GEID are counted and skipped.
  - GEIDs that differ only by leading zeros are reported, not merged.
- **Store key.** Store IDs are normalised: numeric IDs drop leading zeros for matching, and the most common original spelling is used for display.
- **Analysis period.** The business-day range of the paid punches. Records outside it (for example schedule rows for the day after the last punch) are counted and excluded.
- **Test stores.** Stores listed in the manifest `excludeStores`, or detected automatically, are excluded everywhere and listed in Data quality. Automatic detection catches all-one-digit IDs such as `77777`, and stores where more than half of employee names look synthetic.
- **Duplicates.** Exact duplicate rows are detected per file, ignoring serial-number columns such as `S No.`, and removed from schedule, punch, break and approval data. Schedule rows that repeat the same shift segment (GEID, date, store, start, end, type, job) are also removed.

## 2. Schedule vs actual (per GEID × business date) — `analysis/adherence.js`

| Quantity | Formula | Class |
|---|---|---|
| Scheduled paid minutes | union of SHIFT segments − scheduled MEAL segments inside them | Product: meal unpaid, rest paid (`EOEmpShift.java:819-830, 1119-1134`) |
| Overnight shifts | segments chained from 00:00 on a day that also has a segment ending at 24:00 belong to the next calendar day | From data (export splits overnight shifts at midnight) |
| Actual paid minutes | Σ Total Punch Hours of the day's punches (already net of unpaid breaks) | Product: worked = punch − unpaid break (`EOTdyEmpPunDetail.java:527`) |
| Punch → shift assignment | each punch goes to the scheduled block it overlaps most; none = unscheduled | Analysis |
| Early clock-in | max(0, block start − first clock-in) | Product definition (SOS) |
| Late clock-out | max(0, last clock-out − block end) | Product definition (EOS) |
| Late clock-in / early clock-out | time inside the block not worked (offsets) | Product definition |
| No-show | scheduled block with no punch | Analysis |
| Skipped planned meal | min(planned meal − meal break taken, minutes on the clock through the planned meal) | Analysis |
| On-schedule tolerance | 10 min (events counted, and avoidable minutes start, beyond this) | Product (`EOCustomer.properties:30-37`) |
| Violation threshold | 20 min | Product (`…NoViolation = 20`) |

**Check:** actual − scheduled = early + late + unscheduled + skipped meal − late in − early out − no-show − longer breaks + residual. On CMG the residual is −248 h on a +43,874 h difference. It comes from mid-shift gaps between split punches.

**Check:** the scheduled paid minutes computed from shift times agree with the export's own `Schedule Hours` on 100.0% of employee-days (233,401 of 233,420).

## 3. Financial levels (never added together across levels)

| Level | Definition |
|---|---|
| 1. Actual labor expenditure | Σ Total Pay on every paid punch |
| 2. Additional labor hours (gross) | early + late + unscheduled + skipped-meal minutes, per employee |
| 2a. Estimated additional cost | those minutes × the punch's own pay rate, + OT premium |
| 3. Labor above plan (net) | Σ over store-days of max(0, Σ paid − Σ scheduled), at that store-day's average rate |
| 4. Estimated avoidable cost | behavioural minutes × min(1, labor above plan ÷ behavioural minutes) × rate, + drift OT premium |
| 5. Potential savings | 50–100% of level 4. A scenario, not realised savings |

- **Behavioural minutes** are early/late minutes beyond the 10-minute tolerance, plus skipped planned meals.
- **Capping at labor above plan** stops time that filled a gap from being counted as savings. Gaps are no-shows, late arrivals and early leaves at the same store on the same day.
- **Unscheduled shifts are never counted as avoidable.** They may be call-ins, and are shown for validation.
- **Pay rates** come from the punch record.
  - Rates more than 3× the employee's own median (and over $30/h) are treated as keyed salary or bonus amounts. Those rows are costed at the employee's median rate for leakage purposes, while actual expenditure keeps the real pay. They are listed as a finding.
  - If the dataset has no pay rates, hours are reported and $ fields stay empty. No external wage rate is ever assumed.

**No double counting.**
- The base pay of extra minutes sits only in the adherence components.
- Overtime contributes only its **premium**, meaning OT pay minus OT hours × base rate.
- Edits change the same clock times that adherence measures, so their effect is shown separately and never added.

## 4. Overtime — `analysis/overtime.js`

| Quantity | Formula | Class |
|---|---|---|
| OT / DT hours and pay | taken from the punch export (payroll already applied the client's rules) | Data |
| OT premium | Σ max(0, OT pay − OT hours × base rate) (+ the same for DT). The 1.5× / 2× multipliers are used only if the export has no OT pay column | Product multipliers (`EOTdyEmpPunDetail.java:2656-2661`) |
| Weekly threshold | mode of (paid − OT) over OT weeks; CMG = 40 h, matching 5,408 of 5,410 OT weeks | From data (per-site setting in product) |
| Week | Monday–Sunday business week | Product (OT per business week) |
| Scheduled OT | min(OT, max(0, scheduled minutes in the week − threshold)) | Analysis |
| Drift OT | OT − scheduled OT. Its premium is counted as avoidable | Analysis |

Weeks over the threshold with no OT paid are treated as exempt roles, not leakage. On CMG these are mostly GMs. OT hours paid at straight time or $0 are reported for payroll confirmation. If the period ends mid-week, the last week is flagged as possibly understating OT.

## 5. Punch integrity — `analysis/integrity.js`

| Measure | Definition |
|---|---|
| Edit effect on paid time | (adjusted out − adjusted in) − (original out − original in) on each paid punch; costed at that punch's rate |
| Forgotten clock-out correction | original punch ≥ 14 h (product auto-close = 840 min) that was shortened |
| Snap-to-schedule edit | edited time equals a scheduled block start/end exactly |
| Round-time share | share of times on :00/:15/:30/:45 (6.7% by chance) — edited vs device-captured punches |
| Manual punch | Source Id `MANUAL` on the paid punch, or Punch Method `MANUAL` in the audit log |
| Retroactive manual entry | audit "Modified At" − the punch time it records > 60 min |
| Punch method | audit log clock-in/out events; Biometric = BIOMETRIC / FACE / FINGER; "Password" is a PIN punch (product: login type 1 = PIN) |
| Biometric comparison | only when biometric ≥ 200 events and ≥ 2% of events; otherwise reported as not comparable |
| Edits (approval report) | modifications, deletions, restores, system adjustments, and manual "Punch Added". Ordinary clock punches listed in the report are not edits |
| Self-edit (probable) | editor name = employee name on the changed punch (editors have no GEID → name match, needs validation) |
| Shared login | editor account of the form `gm<store>@… : GM, <store>` |
| Edit spike | day with edits > median + 8 × MAD and > 2.5 × median |

## 6. Breaks and compliance — `analysis/compliance.js`

| Measure | Definition | Class |
|---|---|---|
| Meal-eligible shift | employee-day paid > 6 h | Analysis (product setting is per client) |
| Missed meal | eligible day with no meal break recorded | Analysis |
| Short meal | meal break < 30 min | Analysis |
| Minor | Age < 18 on the punch record | Analysis |
| Minor flag mismatch | Age < 18 but Minor = "No" — the clock's minor rules cannot apply | Data |
| Minor late-night | minor punch ending after 22:00 or past midnight | Analysis (state rules vary) |
| Clock breaches | `Type Of Breach` values parsed from "MM/DD/YYYY HH:MM=TYPE" lists, deduplicated | Data |

None of these carries a $ figure unless premium pay is actually recorded.

## 7. Sales and labor — `analysis/sales.js` — monthly only

Sales rows are reduced to **store × month on arrival**. No daily or slot-level sales value is kept, displayed or correlated with labor. This holds even though the CMG sales files contain 15-minute slot rows.

| KPI | Formula | Class |
|---|---|---|
| Sales achievement | monthly actual ÷ monthly forecast | Product (KpiCalculator) |
| SPLH | monthly actual sales ÷ monthly paid hours (punch export) | Product (KpiCalculator) |
| Scheduled SPLH | monthly forecast sales ÷ monthly scheduled paid hours | Product |
| Labor % | monthly punch pay ÷ monthly actual sales | Product |
| Forecast bias | forecast ÷ actual − 1 | Analysis |
| Non-flex month | sales down > 3% vs previous month while paid hours rose; excess = hours − sales ÷ previous month's SPLH | Analysis (estimate, not additive) |
| Peer gap | hours − sales ÷ median SPLH of the store's sales-volume tercile | Analysis (benchmark, not additive) |
| Forecast anomaly | monthly forecast > 2× or < 0.5× actual | Analysis |

Reconciliation: the sales file's own Actual Hours total 100.1% of paid punch hours for the same store-months.

## 7a. Scope: organization / store(s) × date range — `scope.js`

- A filter slices **every** record set before any calculation: schedule, punches, breaks, edits, audit and approval rows, exceptions, punch-method counts and sales. Slicing is by store and business day.
- The whole analysis then re-runs on the slice, including every finding and recommendation, so a finding can only come from records inside the scope.
- **Sales months.** A month counts for sales / SPLH / Labor % only when the range covers every day of data the dataset has for it. March 2026 starts on 2 March in the data, so Mar 2–31 is a complete month. Partial months are listed and excluded, never prorated.
- **Hours and punches** always use exactly the selected days.
- **Weekly OT threshold.** The threshold inferred on the full dataset (40 h) is reused for slices, so a small slice is not re-inferred from too few weeks.
- **Weeks at a range boundary.** OT stays on the punch that earned it. The scheduled vs drift split for a week cut by the range edge uses only the scheduled hours inside the range.
- **Store view vs org row.** In the org view, a GEID's day is filed under the store of its first punch, and weekly OT under the store worked most that week. A store view keeps only that store's records. The two therefore differ slightly where employees worked at more than one store on a day; for store 07750 the difference is under 1.1%, from 9 shared employee-days.

## 7b. Manual punches

| Measure | Definition |
|---|---|
| Manual punch | Paid punch with **Source Id = MANUAL**, a punch keyed in by a manager in the timecard (product: device ID MANUAL = 0). PIN ("Password") and other device punches are **not** manual. Biometric vs non-biometric is a different question. |
| Manual hours / pay | Σ paid minutes / Σ Total Pay on manual punches. This is exposure, not loss |
| Extra time entered manually | Early-start, late-finish and unscheduled minutes where the punch that defines them is manual |
| Beyond tolerance | The part of those early/late minutes beyond the 10-minute tolerance, × rate |
| Avoidable, needs review | Beyond-tolerance minutes on manual punches × the store-day netting factor × rate |
| Manual punches edited | Manual punches whose adjusted time differs from the original, with the paid time added or removed |
| Recurring | Manual punches in ≥ 4 distinct weeks for the GEID |

All manual-punch figures are a lens over the early/late/unscheduled categories and are **never added** to them. The manual "avoidable" is already inside the total avoidable estimate.

## 7c. Labor % ranking

- **Formula:** Actual Labor % = Σ punch pay ÷ Σ actual sales over the complete months in scope, per store. "Actual" because both inputs are actual; no estimated Labor % is produced.
- **Organization average:** total pay ÷ total sales of the ranked stores, weighted by sales.
- **Ranking:** a store is ranked only if it has complete, positive sales for every selected month; others are listed as "not ranked" with the reason. Stores are sorted from highest to lowest Labor %.
- **Status:**

  | Status | Rule |
  |---|---|
  | Unusually high | ≥ 5 points above the average, or ≥ 1.5 standard deviations |
  | High | ≥ 2 points above |
  | Low | ≥ 2 points below |
  | Near average | otherwise |

- **Previous comparable period:** the same number of complete months immediately before the selection. It is shown only when the data contains them.
- **Benchmark:** Σ (Labor % − average) × sales for stores above average. It is a benchmark, not an additive saving.

## 7d. Further findings added with the filters

| Finding | Rule |
|---|---|
| Highest-leakage stores | The top 10% of stores by estimated avoidable cost |
| Improving / deteriorating stores | (Labor above plan + OT premium) per paid hour, first half vs second half of the selected months; a change of > $0.25/h and > 20%. Needs ≥ 4 months and ≥ 4 stores |
| Repeated deviations | GEIDs with ≥ 3 of these patterns, each in ≥ 4 weeks: early clock-in, late clock-out, overtime, manual punches, punch edits, unscheduled shifts |
| Consistently above schedule | Stores whose paid hours exceed scheduled hours in every selected month. Shown as evidence on the labor-above-plan finding |

Findings that need several stores are skipped in a single-store view: the Labor % ranking, persistent stores, peer SPLH (≥ 6 stores), and highest-leakage stores (≥ 5).

## 7e. Employee behaviour patterns — `analysis/behavior.js`

**Building blocks:**
- **Working day:** a business day on which the GEID has paid punches inside the selected scope.
- **Run of consecutive working days:** days the employee did not work are skipped, so they neither break nor extend a run. A day with **no data at all** in scope breaks the run, so missing data never creates a false continuation.
- **Run of consecutive calendar days:** shown separately.
- **Overtime runs:** counted in consecutive Mon–Sun weeks. Dates are clipped to the selected period.

| Measure | Definition |
|---|---|
| Occurrences / share | Days (weeks for OT) showing the pattern ÷ working days (worked weeks) |
| Peak density | Most occurrences in any 10 consecutive working days ("8 of 10") |
| Recent | Occurrences in the last 7 / 14 / 30 days of the selection |
| Rising | The last month (≥ 8 working days) shows the pattern at ≥ 2× the earlier months' rate, with ≥ 4 occurrences |
| Above store peers | ≥ 3× the median rate of colleagues at the same store (≥ 8 working days each) |
| Recurring (flagged) | ≥ 8 occurrences **and** (a run of ≥ 5 working days, or ≥ 50% of working days, or ≥ 8 of any 10). Rising and above-peers patterns are also flagged. Early/late patterns under $100 are left out as immaterial |
| Overtime pattern | ≥ 4 consecutive OT weeks, or OT in ≥ 6 weeks and ≥ 40% of worked weeks |
| Severity | High = run ≥ 5, or ≥ 8 of 10, or ≥ 60% of days (OT: ≥ 4 weeks in a row or ≥ 60%). Critical = High and in the top 5% of its category by $ |
| Store concentration | ≥ 4 employees and ≥ 40% of a store's active staff with the same recurring pattern |

**Pattern categories:**

| Pattern | Detected when | $ impact |
|---|---|---|
| Manual punches | Paid punch with source MANUAL. The clock-in / clock-out split comes from the punch audit's manual entries | Cost of the early/late/unscheduled time recorded through manual punches; avoidable = the netted beyond-tolerance part |
| Early / late | An event beyond the 10-min tolerance that day | Minutes × that day's rate; avoidable = the netted part |
| Early + late same day | Both on the same working day | Both costs on those days |
| Overtime | A week with OT pay | Actual OT premium; avoidable = drift premium |
| Punch edits | A day with an edited paid punch. "Same editor" = share of that employee's edits made by one editor | Net paid time added by edits (forgotten clock-out corrections excluded) |
| Multiple patterns | ≥ 2 different flagged categories | The employee's non-overlapping additional cost |

A pattern is a reason to review, not evidence of misconduct. Manual punches in particular often come from device or access problems.

## 7f. Dollar attribution (no double counting)

**Additional labor cost** is split into five **non-overlapping parts**. Every minute is in exactly one part, so the parts add up to the total:

1. Late clock-outs
2. Early clock-ins
3. Unscheduled shifts
4. Skipped planned meals
5. Overtime premium (premium only; the base pay of OT hours is already in parts 1–4 or in scheduled time)

This is checked by `tools/test-behavior.js`: parts = total, Σ stores = Σ employees = organization.

**Contributing factors** describe *how* some of that time arose and are never added to it:
- additional pay recorded through manual punches
- net paid time added by punch edits

An employee's "additional cost" uses the same non-overlapping parts; their "main cost driver" is the largest part.

## 8. Trends and recurrence

- Monthly rates are normalised per 100 paid hours, so a partial month compares fairly. March 2026 has 30 of 31 days, because data starts on 2 March.
- **Direction** compares the average of the last 3 months with the first 3 (needs ≥ 6 months). A change within ±5% is "stable". No single month is called a trend.
- **Recurring employee:** the pattern appears in ≥ 4 distinct weeks.
- **Persistent store:** in the top quartile for (labor above plan + OT premium) per paid hour in ≥ 5 months. Store-months with fewer than 100 paid hours are ignored.

## 9. Severity and confidence

- **Severity for $ findings** is scaled to the dataset's own labor cost: Critical ≥ 0.75%, High ≥ 0.3%, Medium ≥ 0.1%, otherwise Low.
- **Severity for risk findings** is scaled to the share of records affected.
- **Confidence:**
  - High = direct record counts.
  - Medium = records plus a stated rule or assumption.
  - Low = benchmark or inference.
- **Kind:**
  - Confirmed observation
  - Estimate ($ with stated basis)
  - Risk (no $ claim)
  - Needs validation (a pattern to review before acting)
