# Testing and validation

All tests below were run on the full CMG dataset (`datasets/cmg-mar-oct-2026.zip`, 17 files, 4,639,462 rows) on 2026-11-04. Re-run them with the commands shown.

## 1. Dataset processing

| Check | Result |
|---|---|
| All files detected and classified by header | 17 of 17 recognised: schedule, punches, punch audit, punch-change approvals, breaks, break audit, labor exceptions, 8 monthly sales files, premium pay, misc pay |
| No file silently skipped | Every file appears in Data quality with rows read and accepted |
| ZIP produced by `build-dataset-zip.js` is a standard archive | Listed and read by Windows' own .NET `ZipFile` reader, with all 17 entries and original paths |
| ZIP path = loose-CSV path | Engine results from the ZIP and from the original folder are byte-identical (JSON compared) |
| Browser = Node | The UI result (labor $25,310,901.95; avoidable $707,264.50) equals the Node CLI result |
| Period and months | 2026-03-02 → 2026-10-31, 8 months; March flagged partial (30 of 31 days) |
| Test data | Store 77777 detected (placeholder ID) and excluded; counts excluded per record set are shown |
| Duplicates | Schedule: 166,568 exact duplicate rows (33.6%) + 1,661 repeated segments removed. Approvals: 1,701 removed |
| GEID matching | 3,422 GEIDs. 98 paid but never scheduled, 86 scheduled but never paid, 49 names shared by different GEIDs (not merged), 3 Timecard ≠ GEID — all reported |
| Out-of-period rows | 1,231 schedule rows for 2026-11-01 excluded and reported |

## 2. Calculation validation — `tools/validate-calculations.js`

This is an independent recomputation from the raw CSVs. It uses its own simple parser and no engine code. **Result: 23 passed, 0 failed.**

| Quantity | Independent | Engine |
|---|---:|---:|
| Actual labor expenditure | $25,310,901.95 | $25,310,901.95 |
| Paid hours | 1,629,241.35 | 1,629,241.35 |
| Overtime hours | 29,243.65 | 29,243.65 |
| OT premium | $246,672.43 | $246,672.43 |
| Edited paid punches | 9,188 | 9,188 |
| Scheduled paid hours (export field, deduped) vs engine (shift − meal) | 1,585,331.5 | 1,585,367.75 (0.002%) |
| Actual and forecast sales, each of 8 months (16 checks) | equal to the cent | equal to the cent |
| Biometric punch events | 28 | 28 |

Other built-in checks, shown in the UI under Data quality:
- Regular + OT + DT = Total paid hours on 240,711 of 240,711 punches.
- Shift-time scheduled hours agree with the export's `Schedule Hours` on 100.0% of employee-days.
- Weekly OT threshold inferred at 40 h, matching 5,408 of 5,410 OT weeks.
- Adherence components reconcile: residual −248 h on a +43,874 h difference.
- Sales-file hours = 100.1% of punch hours.

### Hand-traced employee-days (engine vs manual reading of the raw rows)

| GEID / date | Raw facts | Expected | Engine |
|---|---|---|---|
| 1449335 / 2026-10-24 | sched 09:00–15:00 with meal 11:30–12:00; punch 09:11–16:10; no break | sched 330, paid 419, late-in 11, late-out 70, skipped meal 30 (70 + 30 − 11 = 89 = 419 − 330) | all equal |
| 200333410 / 2026-03-08 | sched 17:30–00:00 + 00:00–01:30 (overnight split at midnight); punch 13:46–01:47 | block 17:30–01:30, early 224, late 17, no no-show | all equal |

### Defects found by validation and fixed

1. **Schedule duplicates.** One-third of schedule rows are repeats; they are removed at ingest.
2. **Approval-report rows.** Ordinary clock punches were being counted as edits, which inflated self-edits. Only real changes now count.
3. **OT premium.** Where OT pay was exported as $0 or at straight time, a 0.5× premium was assumed. The engine now uses the exported OT pay and falls back to the multiplier only if the column is absent.
4. **Pay-rate outliers.** Keyed salary or bonus amounts (up to $650/h) inflated leakage costing. Those rows are now costed at the employee's median rate and listed as a finding.
5. **Overnight shifts split at midnight.** These created false no-shows and early clock-ins; they are now re-joined.
6. **Month coverage.** Coverage was checked per file, so monthly sales files raised false warnings. It is now checked per report type.
7. **Minor flag.** The schedule's minor flag was read through the wrong alias; this is fixed.

## 3. Analytical validation

- **Traceability.** Every finding carries evidence and a drill-down to the stores, GEIDs, editors or records behind it.
- **GEID.** Employee findings and drill-downs are keyed by GEID; names are display-only.
- **Recurring vs isolated.**
  - Recurring = the pattern appears in ≥ 4 distinct weeks.
  - Persistent stores = top quartile in ≥ 5 of 8 months.
  - Trends compare the last 3 vs first 3 months, never a single month.
- **No double counting.**
  - Avoidable cost is capped at store-day labor above plan.
  - OT contributes only its premium.
  - Edits and benchmark gaps are labelled "not additive".
- **Monthly sales only.** Sales are reduced to store × month at ingest; the CMG slot-level rows are never used below month.

## 4. UI validation — `tools/ui-test.js` (headless Chrome 156)

**Latest run: 39 passed, 0 failed.**

Default-open behaviour:
- **Over http:** the page opens on the pre-computed CMG analysis in 0.6 s, with no upload and no click.
- **From disk (`file://`):** it also opens in 0.6 s, and the employee day-by-day drill-down works there too.
- **Matches a fresh run:** "Re-analyze from ZIP" recomputed it in the browser in 52 s. The result equals the snapshot (labor $25,310,901.95, avoidable $707,264.50, 21 findings).

Also covered:
- **Landing:** the manifest dropdown loads with the dataset pre-selected; Analyze is enabled; the progress indicator and stages appear.
- **Analysis through the UI:** 17/17 files recognised, period detected, 21 findings; KPIs and charts render.
- **Every view renders without errors:** overview, findings, action plan, schedule vs actual, overtime, punch integrity, breaks & compliance, sales & labor, stores, employees, trends, data quality, method & rules.
- **Drill-downs:** a finding expands with evidence and a drill table; store detail and employee (GEID) detail load.
- **Theme:** the light/dark toggle works.
- **Upload:** the same ZIP was uploaded through the file input and re-analysed.
  - On Analyze, all previous results, charts and navigation clear immediately.
  - The upload result equals the manifest result (labor $25,310,901.95; avoidable $707,264.50; 21 findings).
- **Error handling:**
  - A text file named `.zip` → "not a ZIP archive".
  - A ZIP with no recognisable reports → "No usable punch records".
  - A `.csv` upload → rejected before processing.
- **Layout and errors:** no horizontal scroll at 390 px phone width; no uncaught page errors or console errors.

Two defects found by earlier runs were fixed and re-tested:
1. A table sorted on a non-column key crashed.
2. Month axis labels showed indexes instead of month names.

## 4a. Filters (organization / store × period) — `tools/test-filters.js` and `tools/ui-test.js`

**Engine scenarios (`test-filters.js`): 24 passed, 0 failed.**

| Scenario | Check | Result |
|---|---|---|
| Organization · full period | Equals the base analysis (labor $25,310,901.95, avoidable $707,264.50, 25 findings) | pass |
| Sep 1–30 | Every record set lies inside the range | pass |
| Sep 1–30 | Labor $ = September punch pay ($2,992,626.21) | pass |
| Sep 1–30 | Months, trends and Labor % use September only | pass |
| Sep 1–30 | Findings are regenerated (19) | pass |
| Sep 1–30 | Sales = September monthly sales, not prorated | pass |
| Labor % ranking | Sorted highest → lowest (39.9% → 18.4%, average 25.5%) | pass |
| Labor % ranking | Previous comparable period = Aug | pass |
| Labor % ranking | Top store's Labor % recomputed from pay ÷ sales | pass |
| Store 07750 | Only that store's records; store table has 1 row | pass |
| Store 07750 | Labor $ = its punch pay | pass |
| Store 07750 | Employees all worked there | pass |
| Store 07750 | Store-only findings: no ranking, no persistent-store finding | pass |
| Store 07750 | Within 2% of its org-level row | pass (difference traced to 9 employee-days shared with another store) |
| Sep 10–Oct 20 | Sales / Labor % not calculated (no complete month), explained; hours and punches still analysed | pass |
| Aug 15–Oct 31 | Sales use Sep + Oct; Aug reported as partial | pass |
| Mar 2–31 | Counts as a full month (data starts Mar 2) | pass |
| Manual punches | = punches with Source Id MANUAL: 22,532 punches, 162,485 h, 2,681 employees | pass |
| Manual punches | Correct per month (Sep 2,809) and per store (07750: 349) | pass |
| Manual punches | Manual-punch avoidable sits inside the avoidable total | pass |
| Packed model | Identical results to the original model (11.2 MiB compressed, unpack 1.9 s) | pass |

**Browser (`ui-test.js`): 62 passed, 0 failed.**

The run includes, through the real filter controls:

1. **Scenario 1:** Organization + previous month recalculated in 5.1 s, including the first-time model load. All 121 stores included, one month, KPIs changed, ranking descending in data and on screen, and clicking a ranked store opens its detail.
2. **Scenario 2:** Store chosen through the picker. Every figure is that store's, the heading names it, all 12 views render without errors, Stores opens it directly, and the employee drill-down shows only that store's days.
3. **Scenario 3:** The manual-punch view shows the store's own manual punch count.
4. **Scenario 4:** A custom range (Sep 10 – Oct 20) recalculates.
5. **Scenario 5:** For that partial-month range, sales and Labor % are marked not available and the reason is shown on the ranking page; hours and punch findings are still produced.
6. **Scenario 6:** Reset returns instantly to the full view, and tables sort on header click.

Also passing: filtering when the page is opened from disk (the engine runs from `js/engine.bundle.js`); re-analysis from ZIP in 55 s, equal to the snapshot; upload equal to the manifest result.

**Defects found while testing and fixed:**
- Previous-period Labor % read the wrong day-count field.
- The packed model rounded decimals; it now keeps full precision.
- Model decoding was slow: 8.4 s, now 0.9 s via compiled row builders.
- An edit script's `$'` replacement patterns duplicated part of `views-analysis.js`. The file was rebuilt, and edits now use literal replacement.
- The UI test left Chrome renderers running on Windows; it now kills the process tree. The leftovers had been slowing later runs.

## 4b. Employee behaviour patterns and dollar attribution — `tools/test-behavior.js`

**15 passed, 0 failed.**

Synthetic dataset, run through the real pipeline with known answers:
- **A day with no data breaks a run.** 19 manual days give a longest run of 15, not 19.
- **Days off are skipped.** Three days off inside the run neither break nor extend it: working-day run 12, calendar run 5.
- **PIN / clock punches are never counted as manual.**
- **Early clock-in $ = minutes × rate.** The recurring early pattern costs $114.00 = 19 × 20 min × $18/h.

CMG data:
- **Top manual-punch pattern** (GEID 200260288) matches an independent recount from raw punches: 173 of 173 working days, run of 173.
- **Manual patterns** only ever involve Source Id MANUAL.
- **Cost parts add up:** $4,299,514.49 = additional labor cost.
- **Overtime counted once** (premium $246,672.43).
- **Totals reconcile:** Σ stores = Σ employees = organization.
- **Avoidable ≤ additional** for every employee.
- **Lenses never exceed the total:** manual $783,138, edits $169,778.
- **One employee-day:** 65 min × $13.50 = $14.62.
- **Filters:**
  - Sep 1–30 recalculates 480 patterns, all dated inside September. Overtime week dates are clipped to the selection.
  - A single store's patterns all come from that store's records.

**Browser (`ui-test.js`): 67 passed, 0 failed.** New in this run:
- The store ranking switched to OT cost ranks highest first.
- The Employee behaviour view lists patterns with $ impact and switches category.
- An employee page shows their recurring patterns.

**Engine suites after this change:** `test-filters.js` 24/24 and `validate-calculations.js` 23/23.

**Defects found and fixed in this round:**
- Pattern thresholds were first too loose (5,419 patterns; half the workforce flagged for late clock-outs). They were tightened to recurrence plus materiality, giving 3,006.
- Overtime pattern dates started on the Monday before the selected period. They are now clipped.
- Two UI-test selectors broke because of the new dollar-first layout. They were fixed.

## 5. Original resources unchanged

| Resource | Method | Result |
|---|---|---|
| CMG Data folder (17 files) | SHA-256 recorded at session start, re-checked at the end | all 17 identical |
| `Variance Analysis · Zip Inventory.html` | SHA-256 | identical |
| HW Release (`hubworks`) | `git status --porcelain --untracked-files=no`; full file inventory (path, size, mtime) of 23,492 files compared with the start | no tracked file modified; no file added, removed or resized. Two untracked IDE settings files (`.settings/org.eclipse.jdt*.prefs`) show a newer modification time with identical size. They were not written by this work, and the most likely cause is the IDE's Java tooling. Because they are untracked, their content before/after cannot be compared |

All new files live in `labor-cost-intelligence/`. Temporary outputs were written outside the workspace.
