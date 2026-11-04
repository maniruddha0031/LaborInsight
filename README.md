# Labor Cost Intelligence & Optimization

A browser-based portal that reads a ZIP of labor exports (schedules, punches with pay, punch audit and change-approval reports, breaks, labor exceptions, monthly forecast vs actual sales) and works out **where labor money leaks, why, how much, and what to change**.

It is a reusable product, not a one-off report. Nothing about a client, store, employee, date or result is hard-coded. Every number, finding and recommendation is derived from whichever dataset you load. The first registered dataset is CMG, March–October 2026.

- Runs entirely in the browser. No backend, and no data leaves the machine.
- Employees are joined across every file by **GEID** only.
- Sales are used at **monthly** granularity only.
- Every rule is tagged with its source: verified in the HW Release Schedule/Clock code, inferred from the data, or an analytical assumption.

---

## Run it

**Quickest:** open `index.html`, even by double-clicking it. The portal opens straight onto the **CMG analysis in under a second**, with no upload and no waiting. That analysis is pre-computed in `datasets/cmg-mar-oct-2026.snapshot/`, and drill-downs load from it on demand.

Two things need the page served over HTTP, because browsers block Web Workers and `fetch` on `file://`:
- **Re-analyze from ZIP**, which recomputes the registered dataset in the browser in about 1–2 minutes
- **Uploading a new ZIP**

To serve it:

**Option A — VS Code Live Server.** Open the `labor-cost-intelligence` folder, right-click `index.html`, and choose **Open with Live Server**.

**Option B — the bundled server** (Node 18+, no packages):

```bash
node tools/serve.js 8080
# open http://localhost:8080/
```

**Option C — Python:**

```bash
python -m http.server 8080
```

Then:

1. The default dataset (CMG) opens automatically. The **Dataset** screen lets you switch datasets with **Open analysis** (instant, for datasets with a snapshot), **Re-analyze from ZIP**, or **Upload a ZIP dataset**.
2. Re-analyse or upload: progress shows each stage. The full CMG dataset (632 MB of CSV, 4.6 M rows) takes about 50–90 s in Chrome on a typical laptop.
3. Explore: **Executive overview → Findings → Action plan → Labor % ranking → Employee behavior**, then the detail views (Manual punches, Schedule vs actual, Overtime, Punch integrity, Breaks & compliance, Sales & labor, Stores, Employees, Monthly trends) and the reference views (Data quality, Method & rules).

### Filters: organization or store, and the analysis period

The bar at the top of every view sets the scope for the **whole portal**.

- **View:**
  - **Organization** analyses all stores.
  - **Store ▾** opens a searchable picker. One store gives a store view; several give a comparison set.
- **Period:**
  - Quick options: full period, last 7 / 30 days, latest month, previous month, year to date. Quick options are anchored to the last day in the data, not today.
  - Any single month, or custom start and end dates (then **Apply dates**).
- **Reset filters** returns to the full organization view.

The active scope is always shown under the bar: store(s), number of stores and employees, dates, and which months count for sales.

**How a filter works:**
- Changing a filter re-runs the analysis engine on only the records inside that scope. Every KPI, chart, ranking, finding and recommendation is regenerated for it.
- The first filter loads the data model, which takes a few seconds. After that, a single store takes under a second and one month for the organization about 2–4 s.

**Sales are monthly.** Sales, SPLH and Labor % use only calendar months fully inside the selected dates. A partly selected month is excluded and named, never prorated. Hours, punches, overtime and edits always use exactly the selected days.

**Org view vs store view.** A store view counts only that store's punches. It can differ by a fraction of a percent from the store's row in the organization view, in three cases:
- an employee worked at two stores on the same day
- an employee's typical pay rate is taken over that store's punches only
- weekly overtime is attributed to the store worked most that week

Choosing or uploading another dataset starts a fresh Web Worker and clears every previous result, chart and view, so datasets never mix.

Use a 64-bit desktop browser (Chrome, Edge or Firefox). The CMG dataset needs roughly 2–3 GB of free memory while it is processed.

---

## Adding a dataset

### Register a ZIP in `datasets/` (shows in the dropdown)

1. Put the CSV exports in a ZIP. Any folder layout and any file names work, because files are recognised by their **column headers**. To package a folder reproducibly:
   ```bash
   node tools/build-dataset-zip.js "<folder with CSVs>" datasets/<id>
   ```
   If the ZIP would exceed 95 MB, the script splits it into `<id>.part1.zip`, `<id>.part2.zip`, … (GitHub rejects files over 100 MB).
2. Add an entry to `datasets/manifest.json`:
   ```json
   {
     "id": "client-2027-h1",
     "label": "Client — Jan to Jun 2027",
     "description": "What is in it",
     "period": "2027-01-04 to 2027-06-30",
     "files": ["client-2027-h1.zip"],
     "fileSizes": [12345678],
     "sizeBytes": 12345678,
     "excludeStores": ["99999"],
     "rules": { "punchTolerance": 7 }
   }
   ```
   - `files`: one or more ZIP parts, relative to `datasets/`. All parts are read into one analysis.
   - `excludeStores`: test or training stores to leave out. Stores with placeholder IDs (all one digit, e.g. `77777`) or mostly synthetic employee names are also detected automatically.
   - `rules`: optional per-client overrides of any key in `js/engine/rules.js`.
   - `default`: at the top level, the dataset to pre-select.
3. Make it open instantly (optional but recommended):
   ```bash
   node tools/build-snapshot.js <id>
   ```
   This pre-computes the analysis into `datasets/<id>.snapshot/` (plain script files). It also records the snapshot in `manifest.json` and regenerates `datasets/manifest.js`, the copy the page reads when opened from disk. Re-run it whenever the dataset ZIP or the engine code changes; the CMG snapshot is about 34 MB.
4. Reload the page. No code changes are needed. Without step 3 the dataset still works through **Analyze**. If you edit `manifest.json` by hand, re-run `build-snapshot.js` (or delete `manifest.js`) so the two stay in step.

### Upload a ZIP

Use **Upload a ZIP dataset** on the first screen. It runs through exactly the same pipeline.

### What the ZIP should contain

| Report | Recognised by these columns (any order, common name variants accepted) | Needed for |
|---|---|---|
| **Punches with pay** (required) | GEID, Adjusted Clock In/Out, Total Punch Hours (+ Pay Rate, OT Hours/Pay, Total Pay, Original Clock In/Out, Source Id) | everything |
| Schedule | Busi Date, GEID, Start Time, End Time, Schedule Hours, Break Type | schedule vs actual, avoidable cost |
| Punch audit | GEID, Punch Type, Punch Method, Modified By, Original Clock In | manual-entry timing, punch methods |
| Punch change approvals | GEID, Original/Adjusted Punch Start Time, Description | editors, self-edits, shared logins |
| Breaks | GEID, Adjusted Break In/Out, Break Type, Total Break Hours | meal compliance |
| Break audit | GEID, Adjusted Break In, Punch Type, Modified By | break edits |
| Labor exceptions | GEID, Type Of Breach, Is Manager Authorized | clock-flagged breaches |
| Forecast & actual sales | Store, Date, Forecasted Sales, Actual Sales (+ hours) | monthly sales efficiency |
| Premium / Misc pay | GEID, Premium pay / Misc Pay | premiums actually paid |

Missing reports are reported as unavailable; they never stop the analysis. Only the punch report is required. Excel files inside the ZIP are listed as skipped, so save them as CSV.

---

## Project structure

```
labor-cost-intelligence/
├─ index.html                 app shell + dataset screen
├─ css/app.css                design tokens (light/dark) and components
├─ lib/                       vendored libraries (work offline)
│  ├─ fflate.min.js           streaming ZIP inflate (MIT)
│  └─ chart.umd.min.js        Chart.js 4.4.1 (MIT)
├─ js/
│  ├─ worker.js               runs the engine off the UI thread (one worker per analysis)
│  ├─ engine/                 analysis engine — plain JS, runs in the browser AND in Node
│  │  ├─ files.json           load order (shared by worker and CLI)
│  │  ├─ util.js              naive-local time parsing, interval math, stats
│  │  ├─ csv-stream.js        incremental CSV parser (quotes, embedded commas/newlines)
│  │  ├─ schemas.js           report types, column aliases, header-based classification
│  │  ├─ rules.js             business rules with provenance (product / data / analysis)
│  │  ├─ ingest.js            normalisation, GEID master, per-file validation counters
│  │  ├─ model.js             period, test-store detection, exclusions, GEID checks
│  │  ├─ analysis/
│  │  │  ├─ adherence.js      schedule vs actual per GEID-day, store-day netting
│  │  │  ├─ overtime.js       OT premium, scheduled vs drift OT, threshold inference
│  │  │  ├─ integrity.js      edits, manual entry lag, punch methods, editors, spikes
│  │  │  ├─ compliance.js     meal breaks, minors, labor exceptions, premium pay
│  │  │  └─ sales.js          monthly sales, SPLH, labor %, flex, peer benchmark
│  │  ├─ quality.js           data-quality report and calculation checks
│  │  ├─ insights.js          finding generators (what/where/why/evidence/action/impact)
│  │  ├─ present.js           UI payload, action plan, drill-down queries, snapshot builder
│  │  ├─ scope.js             store / date filtering of the model; portable (packed) model
│  │  └─ pipeline.js          ZIP streaming + orchestration (analyse / analyseFiltered) + summaries/trends
│  ├─ engine.bundle.js        engine + worker as one string (worker for pages opened from disk) — generated
│  └─ ui/                     format, components, views, app controller
├─ datasets/
│  ├─ manifest.json           registered datasets
│  ├─ manifest.js             same, as a script (read when opened from disk) — generated
│  ├─ cmg-mar-oct-2026.zip    CMG dataset (17 CSVs, 84.6 MiB)
│  └─ cmg-mar-oct-2026.snapshot/  pre-computed CMG analysis (result + 64 employee shards + stores) — generated
├─ tools/
│  ├─ serve.js                static server
│  ├─ run-analysis.js         run the same engine from the command line
│  ├─ build-dataset-zip.js    package a folder of CSVs into dataset ZIP(s)
│  ├─ build-snapshot.js       pre-compute a registered dataset so it opens instantly
│  ├─ validate-calculations.js independent recomputation from raw CSV
│  └─ ui-test.js              end-to-end test in headless Chrome
└─ docs/
   ├─ CALCULATIONS.md         KPIs, formulas, rules, assumptions
   ├─ CMG-FINDINGS.md         findings for the CMG dataset
   └─ TESTING.md              what was tested and the results
```

**Pipeline:** ZIP stream → classify each CSV by header → normalise rows (GEID-keyed) → model (period, exclusions, quality) → analyses → financial roll-up → findings → UI. Memory stays bounded because sales rows are reduced to store × month on arrival and ZIP entries are inflated and parsed as streams.

To add an analysis module, write `js/engine/analysis/<name>.js`, list it in `js/engine/files.json`, call it from `pipeline.analyse`, and add a generator to `insights.js`.

---

## Command-line use and tests

The engine is plain JavaScript, so Node runs exactly the code the browser runs.

```bash
# full analysis from a ZIP or a folder of CSVs; writes the UI payload as JSON
node tools/run-analysis.js datasets/cmg-mar-oct-2026.zip --out result.json

# employee behaviour patterns + dollar attribution (synthetic known-answer cases + CMG reconciliation)
node tools/test-behavior.js datasets/cmg-mar-oct-2026.zip

# store / date filter scenarios (scope isolation, partial months, manual punches, Labor % ranking)
node tools/test-filters.js datasets/cmg-mar-oct-2026.zip

# independent cross-check of the engine against the raw CSVs (no engine code used)
node tools/validate-calculations.js "<folder with raw CSVs>" result.json

# end-to-end UI test in headless Chrome (serves the app, drives every view, uploads, error cases)
node tools/ui-test.js --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe" --out ./ui-test-output
```

Results of the last run are in [docs/TESTING.md](docs/TESTING.md).

---

## Git

The repository is meant to include the dataset ZIP; `.gitignore` deliberately does **not** exclude `datasets/*.zip`.

```bash
cd labor-cost-intelligence
git init                      # skip if already a repository
git add .
git status                    # confirm datasets/cmg-mar-oct-2026.zip is staged
git commit -m "Labor Cost Intelligence portal with CMG Mar–Oct 2026 dataset"
git branch -M main
git remote add origin <your-remote-url>
git push -u origin main
```

**Size notes.**
- The CMG snapshot folder adds about 50 MB across 70 files, the largest 3.9 MB. That includes the 15 MB compressed data model the filters use.
- `cmg-mar-oct-2026.zip` is 84.6 MiB. That is under GitHub's 100 MB per-file hard limit but above its 50 MB warning, so the push prints a warning and still succeeds.
- Keep future datasets under 95 MB per file. `build-dataset-zip.js` splits automatically.
- If your host's limits are lower, or the repository grows past ~1 GB, track `datasets/*.zip` with Git LFS: `git lfs install && git lfs track "datasets/*.zip"` before adding them.
- GitHub Pages serves LFS files as pointers, so serve the app another way in that case.

---

## Known limitations

- **Sales are monthly only.** The CMG sales files contain 15-minute slot rows. They are deliberately aggregated to store × month and never used below that.
- **Unscheduled shifts.** Shifts worked without any scheduled shift may be legitimate call-ins. They are reported for review and never counted as avoidable.
- **Editor identity.** Editors carry no GEID in the exports, so the self-edit check matches on name and must be confirmed.
- **Compliance thresholds.** Break and minor thresholds vary by state; the defaults are review thresholds (see `rules.js`).
- **Export cap.** `Punch Audit.csv` has exactly 500,000 rows, which may be an export cap. Counts derived from it are lower bounds.
- **Browser memory.** Very large datasets (well beyond 1 GB of CSV) may exceed browser memory. Run `tools/run-analysis.js` in Node for those.
