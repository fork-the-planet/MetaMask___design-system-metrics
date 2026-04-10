/**
 * Update Timeline and Index Data
 *
 * Aggregates all historical *-data.json files into:
 *   timeline.json — time-series data for dashboard charts
 *   index.json    — manifest of all available data files
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  AllProjectData,
  CodeOwnerTimeline,
  IndexData,
  LatestChange,
  ProjectDataEntry,
  ProjectTimeline,
  TimelineData,
} from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_DIR = path.join(__dirname, '..', 'metrics');

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadAllDataFiles(): Promise<AllProjectData> {
  const files = await fs.readdir(METRICS_DIR);
  const dataFiles = files
    .filter((f: string) => f.endsWith('-data.json') && f.includes('component-metrics'))
    .sort();

  console.log(`  Found ${dataFiles.length} data file(s)`);

  const allData: AllProjectData = { mobile: [], extension: [] };

  for (const file of dataFiles) {
    try {
      const content = await fs.readFile(path.join(METRICS_DIR, file), 'utf8');
      const data = JSON.parse(content);

      const project = data.project as 'mobile' | 'extension';
      if (project === 'mobile' || project === 'extension') {
        allData[project].push({ date: data.date, file, data });
      }
    } catch (err) {
      console.warn(`  ⚠  Error loading ${file}: ${(err as Error).message}`);
    }
  }

  allData.mobile.sort((a, b) => a.date.localeCompare(b.date));
  allData.extension.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`  mobile: ${allData.mobile.length} entries`);
  console.log(`  extension: ${allData.extension.length} entries`);

  return allData;
}

// ---------------------------------------------------------------------------
// Build code owner timeline
// ---------------------------------------------------------------------------

function buildCodeOwnerTimeline(projectData: ProjectDataEntry[]): CodeOwnerTimeline {
  const empty: CodeOwnerTimeline = { dates: [], owners: {} };
  const allOwners = new Set<string>();
  const entriesWithStats: ProjectDataEntry[] = [];

  for (const entry of projectData) {
    const stats = entry.data.summary?.codeOwnerStats;
    if (stats && Object.keys(stats).length > 0) {
      entriesWithStats.push(entry);
      for (const owner of Object.keys(stats)) allOwners.add(owner);
    }
  }

  if (entriesWithStats.length === 0) return empty;

  const timeline: CodeOwnerTimeline = { dates: [], owners: {} };

  for (const owner of allOwners) {
    timeline.owners[owner] = {
      migrationPercentage: [],
      mmdsInstances: [],
      deprecatedInstances: [],
      totalInstances: [],
    };
  }

  for (const entry of entriesWithStats) {
    const stats = entry.data.summary.codeOwnerStats!;
    timeline.dates.push(entry.date);

    for (const owner of allOwners) {
      const s = stats[owner];
      timeline.owners[owner].migrationPercentage.push(s ? parseFloat(s.migrationPercentage) : 0);
      timeline.owners[owner].mmdsInstances.push(s?.mmdsInstances ?? 0);
      timeline.owners[owner].deprecatedInstances.push(s?.deprecatedInstances ?? 0);
      timeline.owners[owner].totalInstances.push(s?.totalInstances ?? 0);
    }
  }

  // Drop owners with no activity across all weeks
  for (const owner of allOwners) {
    if (timeline.owners[owner].totalInstances.every((v) => v === 0)) {
      delete timeline.owners[owner];
    }
  }

  return timeline;
}

// ---------------------------------------------------------------------------
// Build project timeline
// ---------------------------------------------------------------------------

function buildProjectTimeline(projectData: ProjectDataEntry[]): ProjectTimeline {
  const emptyTimeline: ProjectTimeline = {
    dates: [],
    migrationPercentage: [],
    mmdsInstances: [],
    deprecatedInstances: [],
    totalInstances: [],
    componentsFullyMigrated: [],
    componentsInProgress: [],
    componentsNotStarted: [],
    totalComponents: [],
    mmdsComponentsAvailable: [],
    mmdsComponentsList: [],
    newComponents: [],
    codeOwnerTimeline: { dates: [], owners: {} },
    latestChange: null,
  };

  if (projectData.length === 0) return emptyTimeline;

  const timeline: ProjectTimeline = {
    ...emptyTimeline,
    codeOwnerTimeline: buildCodeOwnerTimeline(projectData),
  };

  for (const { date, data } of projectData) {
    const { summary } = data;
    timeline.dates.push(date);
    timeline.migrationPercentage.push(parseFloat(summary.migrationPercentage));
    timeline.mmdsInstances.push(summary.mmdsInstances);
    timeline.deprecatedInstances.push(summary.deprecatedInstances);
    timeline.totalInstances.push(summary.totalInstances);
    timeline.componentsFullyMigrated.push(summary.fullyMigrated);
    timeline.componentsInProgress.push(summary.inProgress);
    timeline.componentsNotStarted.push(summary.notStarted);
    timeline.totalComponents.push(summary.totalComponents);
    timeline.mmdsComponentsAvailable.push(data.mmdsComponentsAvailable ?? 0);
    timeline.mmdsComponentsList.push(data.mmdsComponentsList ?? []);
    timeline.newComponents.push(data.newComponents ?? []);
  }

  timeline.latestChange = calculateLatestChange(timeline);

  return timeline;
}

// ---------------------------------------------------------------------------
// Week-over-week changes
// ---------------------------------------------------------------------------

function calculateLatestChange(timeline: ProjectTimeline): LatestChange | null {
  if (timeline.dates.length < 2) return null;

  const latest = timeline.dates.length - 1;
  const prev = latest - 1;

  return {
    migrationPercentageChange: (
      timeline.migrationPercentage[latest] - timeline.migrationPercentage[prev]
    ).toFixed(2),
    mmdsInstancesChange: timeline.mmdsInstances[latest] - timeline.mmdsInstances[prev],
    deprecatedInstancesChange:
      timeline.deprecatedInstances[latest] - timeline.deprecatedInstances[prev],
    componentsFullyMigratedChange:
      timeline.componentsFullyMigrated[latest] - timeline.componentsFullyMigrated[prev],
    componentsInProgressChange:
      timeline.componentsInProgress[latest] - timeline.componentsInProgress[prev],
    mmdsComponentsAvailableChange:
      timeline.mmdsComponentsAvailable[latest] - timeline.mmdsComponentsAvailable[prev],
  };
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

async function buildTimeline(allData: AllProjectData): Promise<TimelineData> {
  const mobile = buildProjectTimeline(allData.mobile);
  const extension = buildProjectTimeline(allData.extension);

  const allDates = [...mobile.dates, ...extension.dates];

  const timeline: TimelineData = {
    generatedAt: new Date().toISOString(),
    mobile,
    extension,
    summary: {
      totalWeeks: Math.max(mobile.dates.length, extension.dates.length),
      dateRange: {
        start: allDates.length > 0 ? allDates.sort()[0] : null,
        end: allDates.length > 0 ? allDates.sort().at(-1)! : null,
      },
    },
  };

  await fs.writeFile(
    path.join(METRICS_DIR, 'timeline.json'),
    JSON.stringify(timeline, null, 2),
  );

  console.log(`  ✓ timeline.json — ${mobile.dates.length} mobile, ${extension.dates.length} extension data points`);

  return timeline;
}

async function buildIndex(allData: AllProjectData): Promise<IndexData> {
  const index: IndexData = {
    lastUpdated: new Date().toISOString(),
    projects: {
      mobile: allData.mobile.map(({ date, file }) => ({ date, file })),
      extension: allData.extension.map(({ date, file }) => ({ date, file })),
    },
    latest: {
      mobile: allData.mobile.at(-1)?.file ?? null,
      extension: allData.extension.at(-1)?.file ?? null,
    },
  };

  await fs.writeFile(
    path.join(METRICS_DIR, 'index.json'),
    JSON.stringify(index, null, 2),
  );

  console.log(`  ✓ index.json — latest mobile: ${index.latest.mobile ?? 'N/A'}, extension: ${index.latest.extension ?? 'N/A'}`);

  return index;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allData = await loadAllDataFiles();
  const timeline = await buildTimeline(allData);
  await buildIndex(allData);

  if (timeline.mobile.latestChange) {
    const c = timeline.mobile.latestChange;
    const sign = (n: number | string) => (Number(n) >= 0 ? `+${n}` : `${n}`);
    console.log(`  Mobile week-over-week: migration ${sign(c.migrationPercentageChange)}%, MMDS ${sign(c.mmdsInstancesChange)}, deprecated ${sign(c.deprecatedInstancesChange)}`);
  }

  if (timeline.extension.latestChange) {
    const c = timeline.extension.latestChange;
    const sign = (n: number | string) => (Number(n) >= 0 ? `+${n}` : `${n}`);
    console.log(`  Extension week-over-week: migration ${sign(c.migrationPercentageChange)}%, MMDS ${sign(c.mmdsInstancesChange)}, deprecated ${sign(c.deprecatedInstancesChange)}`);
  }
}

main().catch((err) => {
  console.error(`❌ update-timeline failed: ${(err as Error).message}`);
  process.exit(1);
});
