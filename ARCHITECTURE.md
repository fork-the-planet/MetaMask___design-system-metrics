# Design System Metrics — Architecture Plan

> **Status**: Planning  
> **Last updated**: 2026-04-09  
> **Author**: georgewrmarshall

---

## Overview

This document describes the target architecture for the design-system-metrics project. The goal is to stabilize and simplify the pipeline that tracks MetaMask Design System (MMDS) adoption across `metamask-extension` (web) and `metamask-mobile` (React Native).

### Primary Goals

1. **Accuracy** — Metrics should reflect the real state of each repo at the time of scanning
2. **Stability** — The pipeline must run in a consistent, deterministic order with no silent failures
3. **Automation** — Component mappings (deprecated → replacement) derived from `@deprecated` JSDoc tags in source repos, not maintained by hand
4. **Simplicity** — Remove output formats that aren't consumed (XLSX, Slack reports); JSON only
5. **Dashboard as primary output** — All visualizations served from the existing React dashboard

---

## What's Being Removed

| Item | Reason |
|---|---|
| XLSX generation (`exceljs`) | Not consumed by anyone; dashboard covers all data needs |
| Slack report generation (`generate-slack-report.js`) | Not actively used |
| Manual `config.json` maintenance | Replaced by automated `@deprecated` tag parsing |
| Fragmented yarn scripts as the entry point | Replaced by a single orchestrator |

---

## Current Problems

### 1. Incorrect / Stale Metrics
- Props audit doesn't pick up newly released MMDS components because it reads from a stale component list
- Weekly scan can produce wrong counts depending on which scripts ran and in what order
- No enforcement of stage ordering — scripts are run independently

### 2. Config Drift
- `config.json` (~80KB) is partially auto-generated but also requires manual updates
- When design system teams release new components or add replacements, config doesn't update automatically
- The sync script reads actual exports but doesn't parse the deprecation intent in source files

### 3. Complexity Without Value
- ~800-line monolithic `index.js` handles scanning, aggregation, and XLSX generation simultaneously
- Multiple output formats (XLSX + 2 JSON files per run) that serve overlapping purposes
- Slack report and XLSX both require separate post-processing steps that are easy to skip

---

## Target Architecture

### Core Principle

One orchestrator script runs all stages in a fixed order. Config is auto-generated from `@deprecated` JSDoc annotations in the source repos. Output is JSON only.

```
repos (submodules)
      │
      ▼
┌─────────────┐
│ sync-config │  Parse @deprecated tags → generate config.json
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ scan-metrics │  Scan extension + mobile usage → *-data.json, *-summary.json
└──────┬───────┘
       │
       ▼
┌────────────┐
│ scan-props │  Props audit for MMDS components → *-props-audit-*.json
└──────┬─────┘
       │
       ▼
┌────────────────────┐
│ discover-untracked │  Find components with no @deprecated tag → *-untracked-*.json
└──────┬─────────────┘
       │
       ▼
┌─────────────────┐
│ update-timeline │  Aggregate all *-data.json files → timeline.json, index.json
└──────┬──────────┘
       │
       ▼
┌──────────┐
│ validate │  Consistency checks across outputs
└──────────┘
       │
       ▼
 metrics/ → dashboard/public/metrics/
```

---

## Folder Structure (Target)

```
design-system-metrics/
├── pipeline/
│   ├── run.js                   # Orchestrator — single entry point
│   ├── sync-config.js           # Rewritten: parses @deprecated tags
│   ├── scan-metrics.js          # Extracted from index.js; JSON only
│   ├── scan-props.js            # Fixed props audit
│   ├── discover-untracked.js    # Reoriented: finds untagged components
│   └── update-timeline.js       # Moved from scripts/
├── scripts/
│   └── lib/                     # Shared utilities (AST parsing, file scanning)
├── config/
│   ├── config.json              # AUTO-GENERATED (do not edit manually)
│   └── config.static.json       # Manual stable config (patterns, packages, ignores)
├── metrics/                     # Generated JSON outputs (git-tracked)
├── dashboard/                   # React/Vite frontend (unchanged)
├── repos/                       # Git submodules (read-only)
│   ├── metamask-extension
│   ├── metamask-mobile
│   └── metamask-design-system
└── __tests__/                   # Jest test suite
```

---

## Stage Details

### Stage 1: `sync-config` (Rewritten)

**Purpose**: Auto-generate `config.json` from `@deprecated` JSDoc tags in the legacy component libraries of each repo.

**How it works**:

1. Scan legacy component folders:
   - Extension: `repos/metamask-extension/ui/components/component-library/**/*.tsx`
   - Mobile: `repos/metamask-mobile/app/component-library/components/**/*.tsx`

2. For each component file, look for a `@deprecated` JSDoc annotation on the exported component. Extract:
   - **Deprecated component name** — from the export identifier
   - **Replacement component name** — parsed from the tag text (e.g. `use \`Button\``)
   - **Replacement package** — parsed from the tag text (always `@metamask/design-system-react` or `@metamask/design-system-react-native`)

3. Cross-reference replacement component names against actual exports from:
   - `repos/metamask-design-system/packages/design-system-react/src/components/index.ts`
   - `repos/metamask-design-system/packages/design-system-react-native/src/components/index.ts`
   - Flag mismatches (deprecated tag references a component that doesn't exist in MMDS exports)

4. Write the deprecated component mappings into `config.json` (auto-generated section).

5. Merge with `config.static.json` (file patterns, ignore globs, package names) to produce the final `config.json`.

**@deprecated tag formats observed** (both repos follow these patterns):

```
// Simple
@deprecated Please update your code to use `Button` from `@metamask/design-system-react`

// With variant
@deprecated Please update your code to use `Button` from `@metamask/design-system-react` with variant `ButtonVariant.Primary`

// Multi-replacement (ButtonLink)
@deprecated Use `TextButton` from `@metamask/design-system-react` for inline links.
            Use `Button` from `@metamask/design-system-react` with `variant={ButtonVariant.Tertiary}` for standalone.

// Internal redirect (not an MMDS replacement)
@deprecated Please update your code to use `Skeleton` from `app/component-library/components-temp/Skeleton`
```

**Parsing strategy**:
- Regex to extract backtick-quoted component name before `from`
- Regex to extract package name after `from`
- If multiple replacements found in one tag → record all; any of them counts as "migrated"
- If replacement package is not an MMDS package → mark component as "no MMDS replacement yet"

**Multi-replacement resolution**:
> A component instance is considered **migrated** if it uses **any** of the valid replacement components listed in the `@deprecated` tag. Example: ButtonLink usages are migrated if they import either `TextButton` or `Button` (with Tertiary variant) from `@metamask/design-system-react`.

**What stays in `config.static.json`** (never auto-generated):
```json
{
  "projects": {
    "extension": {
      "rootFolder": "repos/metamask-extension/ui",
      "legacyComponentFolder": "repos/metamask-extension/ui/components/component-library",
      "filePattern": "repos/metamask-extension/ui/**/*.{js,tsx}",
      "ignoreFolders": ["repos/metamask-extension/ui/components/component-library"],
      "currentPackages": ["@metamask/design-system-react"],
      "codeOwnerMetricIgnoreGlobs": ["**/deprecated/**"]
    },
    "mobile": {
      "rootFolder": "repos/metamask-mobile/app",
      "legacyComponentFolder": "repos/metamask-mobile/app/component-library/components",
      "filePattern": "repos/metamask-mobile/app/**/*.{js,tsx}",
      "ignoreFolders": ["repos/metamask-mobile/app/component-library"],
      "currentPackages": ["@metamask/design-system-react-native"],
      "codeOwnerMetricIgnoreGlobs": []
    }
  }
}
```

---

### Stage 2: `scan-metrics` (Simplified)

**Purpose**: Scan each project's source files, count deprecated and MMDS component usage, output JSON.

**Changes from current `index.js`**:
- Remove all XLSX generation
- Remove ExcelJS dependency
- Single responsibility: scan → count → write JSON
- Reads config output from Stage 1 (enforced by orchestrator)

**Outputs** (unchanged format, consumed by dashboard):
- `metrics/{project}-component-metrics-{date}-data.json`
- `metrics/{project}-component-metrics-{date}-summary.json`

---

### Stage 3: `scan-props` (Fixed)

**Purpose**: For each MMDS component, analyze how its props are being used across the consuming repos.

**Current bug**: Reads a static component list, misses newly released MMDS components.

**Fix**: Read the current MMDS component list from the freshly generated `config.json` (from Stage 1). Any component in `currentComponents` gets audited. No manual list required.

**Output** (unchanged):
- `metrics/{component}-props-audit-{date}.json`
- `metrics/{component}-props-audit-latest.json` (symlink/copy for dashboard)

---

### Stage 4: `discover-untracked` (Reoriented)

**Purpose**: Find components that appear in scan results but have no `@deprecated` tag in the source repo.

**New definition of "untracked"**: A component is untracked if it exists in the legacy component folder but does not have a `@deprecated` JSDoc annotation. Previously this relied on config.json presence; now it derives directly from source annotations.

**This aligns the tool with the automation strategy**: the team's action item when a component appears here is to add a `@deprecated` tag (once an MMDS replacement exists), not to update config.json.

**Output** (unchanged):
- `metrics/{project}-untracked-{date}.json`
- `metrics/{project}-untracked-latest.json`

---

### Stage 5: `update-timeline`

**Purpose**: Aggregate all `*-data.json` files into `timeline.json` for trend charts. Creates `index.json` manifest.

**Changes**: Move from `scripts/` to `pipeline/`. Logic is unchanged — this is working well.

---

### Stage 6: `validate`

**Purpose**: Consistency checks across all outputs. Fail the pipeline if data looks wrong.

**Changes**: Move from `scripts/` to `pipeline/`. Expand checks to include:
- Verify `config.json` was generated this run (not stale)
- Verify all expected output files were produced
- Verify migration % is within plausible bounds (catch scan failures)

---

### The Orchestrator: `pipeline/run.js`

Single entry point. Replaces all the individual yarn scripts as the primary way to run the pipeline.

```bash
# Run full pipeline
yarn pipeline

# Run with a specific date (for backfill)
yarn pipeline --date 2026-03-14

# Run specific stages (for debugging)
yarn pipeline --only sync-config,scan-metrics
```

**Behavior**:
- Runs all stages in order, exits on first failure
- Logs clearly which stage is running and how long it took
- Produces a run summary at the end (files written, any warnings)

**CI entry point** (`.github/workflows/weekly-metrics.yml`):
```yaml
- run: yarn update-repos
- run: yarn pipeline
```

---

## Dashboard

The React dashboard (`dashboard/`) is **unchanged** in terms of code. All fixes come from the pipeline producing accurate data. The dashboard already displays:

- Migration % trend (line chart over time) ✅ — primary value
- Code owner adoption breakdown ✅ — primary value
- Per-component migration status ✅
- Props audit results ✅
- Untracked components ✅

Future feature (out of scope for this refactor): migration guidance per component (links to MMDS docs, migration guides from the `@see` tags in `@deprecated` annotations).

---

## Config File Transition

| File | Who writes it | Contents |
|---|---|---|
| `config.static.json` | Humans | File patterns, ignore globs, package names, CODEOWNERS config |
| `config.json` | `sync-config` (auto) | Deprecated component mappings with replacements |

During transition, the existing `config.json` remains as the source of truth until `sync-config` is rewritten and validated to produce equivalent (or better) output. The rewrite should be validated by diffing the auto-generated output against the current hand-maintained file.

---

## @deprecated Coverage Today

As of 2026-04-09 (approximate, based on repo scan):

| Repo | Legacy components | With `@deprecated` | Coverage |
|---|---|---|---|
| metamask-extension | ~143 | ~45 | ~31% |
| metamask-mobile | ~203 | ~38 | ~18% |

The low coverage means many components won't appear in auto-generated config yet. This is expected — as teams add `@deprecated` tags to components that have MMDS replacements, coverage and metrics accuracy will improve over time. The `discover-untracked` stage surfaces the gap.

---

## Implementation Phases

### Phase 1 — Remove Spreadsheets & Slack Reports ✅ (2026-04-09)
- Removed all XLSX generation and `ExcelJS` from `index.js`
- Removed `exceljs` dependency (and its 70+ transitive deps)
- Deleted `scripts/generate-slack-report.js`, `scripts/xlsx-to-json.js`, `scripts/fetch-migration-list.js`
- Removed `slack-report`, `extract-json`, `fetch-migration-targets` yarn scripts
- Updated CI workflow to remove Slack report step
- Output filename handling updated: base path derived from config, no `.xlsx` extension needed
- **Outcome**: Simpler codebase, JSON-only output, no behavior change for dashboard

### Phase 2 — Orchestrator
- Create `pipeline/run.js`
- Move `update-timeline.js` and `validate-metrics-consistency.js` into `pipeline/`
- Wire up CI to use `yarn pipeline` instead of individual commands
- **Outcome**: Stable ordering, one command to run everything

### Phase 3 — Rewrite `sync-config`
- Parse `@deprecated` JSDoc from component folders in both repos
- Extract replacement component + package
- Cross-reference against MMDS exports
- Generate `config.json` automatically
- Split static config into `config.static.json`
- Validate against current hand-maintained `config.json` (diff to catch regressions)
- **Outcome**: Config stays accurate as teams add/update `@deprecated` tags

### Phase 4 — Fix `scan-props`
- Read MMDS component list from freshly generated `config.json`
- Ensure it runs after sync-config in the orchestrator
- **Outcome**: Props audit stays current with MMDS releases

### Phase 5 — Reorient `discover-untracked`
- Change definition to: components in legacy folder without `@deprecated` tag
- **Outcome**: Dashboard untracked page reflects actual annotation gaps, not config gaps

---

## Open Questions

- [ ] **Config transition validation**: How do we confirm the auto-generated config produces equivalent metrics to the current hand-maintained config before switching over? Propose running both in parallel for one weekly cycle and comparing outputs.

- [ ] **Partial @deprecated tags**: Some mobile components have tags pointing to internal `components-temp/` rather than MMDS packages. Should these appear in metrics as "no MMDS replacement yet" or be excluded entirely?

- [ ] **`components-temp/` in mobile**: This folder contains ~140 components that are newer but not yet in the MMDS package. Should usage of these be tracked as "migrated" or "in progress"? Currently unclear.

- [ ] **Variant-level tracking**: For multi-replacement cases (e.g. ButtonLink → TextButton or Button+Tertiary), do we want to track _which_ replacement was chosen, or just that migration happened? Tracking variants would add dashboard value for design system team to see if migration guidance is being followed.

- [ ] **@deprecated tag authoring guide**: Once this system is in place, the extension and mobile teams need to know the expected `@deprecated` tag format so the scanner can parse it correctly. Should there be a contributing guide or lint rule enforcing the format?

---

## Resolved Decisions

- **Multi-replacement migration counting**: A component instance is **migrated** if it uses any of the valid replacements listed in its `@deprecated` tag. (Decided 2026-04-09)
- **MMDS component count denominator**: Use total actual MMDS exports (from the design system packages) as the denominator. No Jira-managed target list. "New components this week" derived automatically by diffing current exports against the previous week's snapshot. (Decided 2026-04-09)
- **Jira integration removed**: `migration-targets.json` and `fetch-migration-list.js` retired. The total MMDS component count from actual package exports is the source of truth — no achievable target number. (Decided 2026-04-09)
- **Spreadsheets**: Removed entirely. Dashboard covers all data needs.
- **Slack reports**: Removed. Not actively used.
- **Props audit**: Kept and fixed. Valuable for driving MMDS component API adoption and validating component API design.
- **Discover-untracked**: Kept and reoriented around `@deprecated` tag gaps.
- **Historical timeline**: Kept unchanged. Charts are primary dashboard value.
- **Code owner charts**: Kept. Primary value for consuming teams tracking their own progress.
