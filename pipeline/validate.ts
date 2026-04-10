/**
 * Validate Metrics Consistency
 *
 * Checks that data.json and summary.json pairs are internally consistent,
 * and that timeline.json and index.json reflect the latest data files.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IndexData, MetricsData, TimelineData } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_DIR = path.join(__dirname, '..', 'metrics');
const PROJECTS = ['mobile', 'extension'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function check(actual: unknown, expected: unknown, label: string, errors: string[]): void {
  if (String(actual) !== String(expected)) {
    errors.push(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Validate a data/summary pair for a given project + date
// ---------------------------------------------------------------------------

async function validatePair(
  project: string,
  date: string,
  errors: string[],
): Promise<void> {
  const base = `${project}-component-metrics-${date}`;
  const dataPath = path.join(METRICS_DIR, `${base}-data.json`);
  const summaryPath = path.join(METRICS_DIR, `${base}-summary.json`);

  let data: MetricsData;
  let summary: Record<string, unknown>;

  try {
    [data, summary] = await Promise.all([
      readJson<MetricsData>(dataPath),
      readJson<Record<string, unknown>>(summaryPath),
    ]);
  } catch (err) {
    errors.push(`${base}: could not read files — ${(err as Error).message}`);
    return;
  }

  check(data.project, project, `${base}.project`, errors);
  check(data.date, date, `${base}.date`, errors);
  check(summary['project'], project, `${base}-summary.project`, errors);
  check(summary['date'], date, `${base}-summary.date`, errors);

  check(data.summary.totalComponents, summary['componentsTracked'], `${base}.totalComponents`, errors);
  check(data.summary.mmdsInstances, summary['mmdsInstances'], `${base}.mmdsInstances`, errors);
  check(data.summary.deprecatedInstances, summary['deprecatedInstances'], `${base}.deprecatedInstances`, errors);
  check(data.summary.totalInstances, summary['totalInstances'], `${base}.totalInstances`, errors);
  check(data.summary.migrationPercentage, summary['migrationPercentage'], `${base}.migrationPercentage`, errors);
}

// ---------------------------------------------------------------------------
// Validate timeline and index against latest data
// ---------------------------------------------------------------------------

async function validateTimelineAndIndex(errors: string[]): Promise<void> {
  let timeline: TimelineData;
  let index: IndexData;

  try {
    [timeline, index] = await Promise.all([
      readJson<TimelineData>(path.join(METRICS_DIR, 'timeline.json')),
      readJson<IndexData>(path.join(METRICS_DIR, 'index.json')),
    ]);
  } catch (err) {
    errors.push(`Could not read timeline.json or index.json — ${(err as Error).message}`);
    return;
  }

  for (const project of PROJECTS) {
    const latestFile = index.latest?.[project];
    if (!latestFile) {
      errors.push(`index.latest.${project} is missing`);
      continue;
    }

    const latestDate = latestFile.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!latestDate) {
      errors.push(`index.latest.${project} has invalid filename: ${latestFile}`);
      continue;
    }

    const projectTimeline = timeline[project];
    const lastIdx = projectTimeline.dates.length - 1;

    if (lastIdx < 0) {
      errors.push(`timeline.${project}.dates is empty`);
      continue;
    }

    let latestData: MetricsData;
    try {
      latestData = await readJson<MetricsData>(path.join(METRICS_DIR, latestFile));
    } catch (err) {
      errors.push(`Could not read ${latestFile} — ${(err as Error).message}`);
      continue;
    }

    check(projectTimeline.dates[lastIdx], latestDate, `timeline.${project}.latestDate`, errors);
    check(projectTimeline.mmdsInstances[lastIdx], latestData.summary.mmdsInstances, `timeline.${project}.mmdsInstances`, errors);
    check(projectTimeline.deprecatedInstances[lastIdx], latestData.summary.deprecatedInstances, `timeline.${project}.deprecatedInstances`, errors);
    check(projectTimeline.totalInstances[lastIdx], latestData.summary.totalInstances, `timeline.${project}.totalInstances`, errors);
    check(
      projectTimeline.migrationPercentage[lastIdx],
      parseFloat(latestData.summary.migrationPercentage),
      `timeline.${project}.migrationPercentage`,
      errors,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const errors: string[] = [];
  const files = await fs.readdir(METRICS_DIR);

  for (const project of PROJECTS) {
    const dates = files
      .filter((f: string) => f.startsWith(`${project}-component-metrics-`) && f.endsWith('-summary.json'))
      .map((f: string) => f.match(/(\d{4}-\d{2}-\d{2})/)?.[1])
      .filter((d: string | undefined): d is string => Boolean(d))
      .sort();

    for (const date of dates) {
      await validatePair(project, date, errors);
    }
  }

  await validateTimelineAndIndex(errors);

  if (errors.length > 0) {
    console.error(`  ❌ ${errors.length} consistency error(s):`);
    for (const e of errors) console.error(`    - ${e}`);
    process.exit(1);
  }

  console.log(`  ✓ All consistency checks passed`);
}

main().catch((err) => {
  console.error(`❌ validate failed: ${(err as Error).message}`);
  process.exit(1);
});
