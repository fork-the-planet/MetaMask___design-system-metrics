import { useMemo, useState } from 'react';
import { useUntrackedData, useUntrackedTimeline, useMetricsData } from '../hooks/useMetricsData';
import { Loading } from '../components/Loading';
import { ErrorMessage } from '../components/ErrorMessage';
import type { UntrackedData, UntrackedComponent, UntrackedProjectTimeline } from '../types/metrics';
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_ORDER = { exact: 0, high: 1, medium: 2 } as const;
const CONFIDENCE_MULTIPLIER = { exact: 3, high: 2, medium: 1 } as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type ReplaceSortField = 'priority' | 'instances' | 'fileCount' | 'confidence';
type CandidateSortField = 'breadth' | 'instances' | 'fileCount';
interface SortState<F extends string> { field: F; dir: 'asc' | 'desc' }

// ─── Filters ─────────────────────────────────────────────────────────────────

/**
 * A replaceable one-off: strictly local, imported from a relative path in the repo.
 * Excludes mixed (partially platform/third-party), platform-primitive, and third-party.
 */
function isOneoffReplaceable(row: UntrackedComponent): boolean {
  return row.sourceCategory === 'local-oneoff';
}

/**
 * A DS roadmap candidate: strict local-oneoff with a traceable canonical source path.
 * Excludes untraceable (local or re-export) entries with no path context.
 */
function isDSCandidate(row: UntrackedComponent): boolean {
  return row.sourceCategory === 'local-oneoff' &&
    !!row.canonicalSource &&
    !row.canonicalSource.startsWith('(');
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** Priority = instances × confidence weight. Higher = bigger migration win. */
function priorityScore(row: UntrackedComponent): number {
  const conf = row.mmdsMatches[0]?.confidence as keyof typeof CONFIDENCE_MULTIPLIER | undefined;
  return row.instances * (conf ? (CONFIDENCE_MULTIPLIER[conf] ?? 1) : 1);
}

/** Unique teams using this component (excluding @unknown). */
function teamBreadth(row: UntrackedComponent): number {
  if (!row.codeOwnerBreakdown) return 0;
  return Object.keys(row.codeOwnerBreakdown).filter(o => o !== '@unknown').length;
}

/** Roadmap score = instances × teams. Higher = stronger DS standardisation signal. */
function roadmapScore(row: UntrackedComponent): number {
  return row.instances * Math.max(teamBreadth(row), 1);
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

function sortReplaceable(rows: UntrackedComponent[], sort: SortState<ReplaceSortField>): UntrackedComponent[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (sort.field === 'priority') cmp = priorityScore(a) - priorityScore(b);
    else if (sort.field === 'instances') cmp = a.instances - b.instances;
    else if (sort.field === 'fileCount') cmp = a.fileCount - b.fileCount;
    else if (sort.field === 'confidence') {
      const aO = CONFIDENCE_ORDER[a.mmdsMatches[0]?.confidence as keyof typeof CONFIDENCE_ORDER] ?? 3;
      const bO = CONFIDENCE_ORDER[b.mmdsMatches[0]?.confidence as keyof typeof CONFIDENCE_ORDER] ?? 3;
      cmp = aO - bO;
    }
    return sort.dir === 'desc' ? -cmp : cmp;
  });
}

function sortCandidates(rows: UntrackedComponent[], sort: SortState<CandidateSortField>): UntrackedComponent[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (sort.field === 'breadth') cmp = roadmapScore(a) - roadmapScore(b);
    else if (sort.field === 'instances') cmp = a.instances - b.instances;
    else if (sort.field === 'fileCount') cmp = a.fileCount - b.fileCount;
    return sort.dir === 'desc' ? -cmp : cmp;
  });
}

// ─── Row filtering ────────────────────────────────────────────────────────────

function filterReplaceableRows(rows: UntrackedComponent[], teamFilter: string, search: string): UntrackedComponent[] {
  return rows
    .filter(isOneoffReplaceable)
    .filter(row => !teamFilter || (row.codeOwners ?? []).includes(teamFilter))
    .filter(row => !search || row.component.toLowerCase().includes(search.toLowerCase()));
}

function filterCandidateRows(rows: UntrackedComponent[], teamFilter: string, search: string): UntrackedComponent[] {
  return rows
    .filter(isDSCandidate)
    .filter(row => !teamFilter || (row.codeOwners ?? []).includes(teamFilter))
    .filter(row => !search || row.component.toLowerCase().includes(search.toLowerCase()));
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function mmdsComponentUrl(componentName: string, project: string): string {
  const pkg = project === 'mobile' ? 'design-system-react-native' : 'design-system-react';
  return `https://github.com/MetaMask/metamask-design-system/tree/main/packages/${pkg}/src/components/${componentName}`;
}

/** Always-valid code search — never 404s regardless of path accuracy. */
function componentSearchUrl(componentName: string, project: string): string {
  const repo = project === 'mobile' ? 'metamask-mobile' : 'metamask-extension';
  return `https://github.com/MetaMask/${repo}/search?q=${encodeURIComponent(componentName)}&type=code`;
}

/**
 * Best-effort direct tree link. Returns null for bare names or untraceable paths,
 * so callers can fall back to componentSearchUrl.
 */
function sourceTreeUrl(canonicalSource: string | undefined, project: string): string | null {
  if (!canonicalSource || canonicalSource.startsWith('(') || canonicalSource === '—') return null;
  if (!canonicalSource.includes('/')) return null;
  const repo = project === 'mobile' ? 'metamask-mobile' : 'metamask-extension';
  const base = project === 'mobile' ? 'app' : 'ui';
  const normalised = canonicalSource.startsWith(base + '/') ? canonicalSource : `${base}/${canonicalSource}`;
  return `https://github.com/MetaMask/${repo}/tree/main/${normalised}`;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function formatTeam(owner: string): string {
  return owner.replace('@MetaMask/', '').replace(/^@/, '');
}

function teamsDisplay(codeOwners: string[] | undefined): string {
  if (!codeOwners || codeOwners.length === 0) return '—';
  const names = codeOwners.filter(o => o !== '@unknown').map(formatTeam);
  return names.length > 0 ? names.join(', ') : '—';
}

/** Source link cell: tree URL when path is reliable, code search otherwise. */
function SourceCell({ canonicalSource, componentName, project }: {
  canonicalSource: string | undefined;
  componentName: string;
  project: string;
}) {
  const treeUrl = sourceTreeUrl(canonicalSource, project);
  const searchUrl = componentSearchUrl(componentName, project);
  const display = canonicalSource || componentName;

  if (treeUrl) {
    return (
      <div className="flex items-center gap-1.5">
        <a
          href={treeUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[200px]"
          title={canonicalSource}
        >
          {display}
        </a>
        <a
          href={searchUrl}
          target="_blank"
          rel="noreferrer"
          title="Search in repo"
          className="shrink-0 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
        </a>
      </div>
    );
  }

  return (
    <a
      href={searchUrl}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[200px] block"
      title={`Search for ${componentName} in repo`}
    >
      {display}
    </a>
  );
}

// ─── Confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: 'exact' | 'high' | 'medium' }) {
  const styles = {
    exact: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ring-1 ring-emerald-300 dark:ring-emerald-700',
    high: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 ring-1 ring-yellow-300 dark:ring-yellow-700',
    medium: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  };
  const labels = { exact: 'Exact', high: 'Strong', medium: 'Partial' };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[confidence]}`}>
      {labels[confidence]}
    </span>
  );
}

// ─── Sort / Static headers ────────────────────────────────────────────────────

function SortHeader<F extends string>({ label, field, sortState, onSort, className = '' }: {
  label: string; field: F; sortState: SortState<F>; onSort: (f: F) => void; className?: string;
}) {
  const active = sortState.field === field;
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider cursor-pointer select-none text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 ${className}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={active ? '' : 'opacity-30'}>{active ? (sortState.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
      </span>
    </th>
  );
}

function StaticHeader({ label, className = '' }: { label: string; className?: string }) {
  return (
    <th className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 ${className}`}>
      {label}
    </th>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ title, value, subtitle, accent = 'default' }: {
  title: string; value: string | number; subtitle: string;
  accent?: 'default' | 'green' | 'blue' | 'purple' | 'amber';
}) {
  const colors = {
    default: 'text-gray-900 dark:text-white',
    green: 'text-emerald-600 dark:text-emerald-400',
    blue: 'text-blue-600 dark:text-blue-400',
    purple: 'text-purple-600 dark:text-purple-400',
    amber: 'text-amber-600 dark:text-amber-400',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-5 flex flex-col gap-1">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{title}</p>
      <p className={`text-3xl font-bold ${colors[accent]}`}>{value}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
    </div>
  );
}

// ─── Priority bar ─────────────────────────────────────────────────────────────

function PriorityBar({ score, maxScore }: { score: number; maxScore: number }) {
  const pct = maxScore > 0 ? Math.min((score / maxScore) * 100, 100) : 0;
  const color = pct > 60 ? 'bg-red-400 dark:bg-red-500'
    : pct > 30 ? 'bg-yellow-400 dark:bg-yellow-500'
    : 'bg-blue-300 dark:bg-blue-600';
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400 w-8 text-right">{score}</span>
    </div>
  );
}

// ─── Replace Now table ────────────────────────────────────────────────────────

function ReplaceNowTable({ rows, project, search, onSearch, sort, onSort }: {
  rows: UntrackedComponent[]; project: string;
  search: string; onSearch: (v: string) => void;
  sort: SortState<ReplaceSortField>; onSort: (f: ReplaceSortField) => void;
}) {
  const maxPriority = useMemo(() => Math.max(...rows.map(priorityScore), 1), [rows]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <div className="p-6 pb-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs font-bold">✓</span>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Replace with MMDS today
              {rows.length > 0 && <span className="ml-2 text-sm font-normal text-gray-400">({rows.length})</span>}
            </h3>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 ml-8">
            In-repo one-off components with a direct MMDS equivalent. Sorted by migration impact.
          </p>
        </div>
        <input
          type="text"
          placeholder="Filter components…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <StaticHeader label="#" className="w-8" />
              <StaticHeader label="Component" />
              <SortHeader label="Priority" field="priority" sortState={sort} onSort={onSort} className="w-36" />
              <SortHeader label="Instances" field="instances" sortState={sort} onSort={onSort} />
              <SortHeader label="Files" field="fileCount" sortState={sort} onSort={onSort} />
              <StaticHeader label="MMDS Replacement" />
              <SortHeader label="Confidence" field="confidence" sortState={sort} onSort={onSort} />
              <StaticHeader label="Source" />
              <StaticHeader label="Teams" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
            {rows.map((row, i) => {
              const bestMatch = row.mmdsMatches[0];
              return (
                <tr
                  key={row.component}
                  className={`${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-800/40'} hover:bg-emerald-50/30 dark:hover:bg-emerald-900/10 transition-colors`}
                >
                  <td className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white">{row.component}</td>
                  <td className="px-4 py-3">
                    <PriorityBar score={priorityScore(row)} maxScore={maxPriority} />
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums text-gray-700 dark:text-gray-300">{row.instances.toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">{row.fileCount}</td>
                  <td className="px-4 py-3 text-sm">
                    {bestMatch ? (
                      <a
                        href={mmdsComponentUrl(bestMatch.component, project)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline font-mono font-medium"
                      >
                        {bestMatch.component}
                      </a>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {bestMatch ? <ConfidenceBadge confidence={bestMatch.confidence} /> : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <SourceCell canonicalSource={row.canonicalSource} componentName={row.component} project={project} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {teamsDisplay(row.codeOwners)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-400 dark:text-gray-500">
                  No components match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── DS Roadmap table ─────────────────────────────────────────────────────────

function DSRoadmapTable({ rows, project, search, onSearch, sort, onSort }: {
  rows: UntrackedComponent[]; project: string;
  search: string; onSearch: (v: string) => void;
  sort: SortState<CandidateSortField>; onSort: (f: CandidateSortField) => void;
}) {
  const maxScore = useMemo(() => Math.max(...rows.map(roadmapScore), 1), [rows]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <div className="p-6 pb-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-xs font-bold">+</span>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Introduce to MMDS
              {rows.length > 0 && <span className="ml-2 text-sm font-normal text-gray-400">({rows.length})</span>}
            </h3>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 ml-8">
            Custom in-repo components with no MMDS equivalent and a traceable source. High usage across multiple teams signals a DS roadmap opportunity.
          </p>
        </div>
        <input
          type="text"
          placeholder="Filter components…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-100 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <StaticHeader label="#" className="w-8" />
              <StaticHeader label="Component" />
              <SortHeader label="Breadth signal" field="breadth" sortState={sort} onSort={onSort} className="w-36" />
              <SortHeader label="Instances" field="instances" sortState={sort} onSort={onSort} />
              <SortHeader label="Files" field="fileCount" sortState={sort} onSort={onSort} />
              <StaticHeader label="Teams" />
              <StaticHeader label="Source" />
              <StaticHeader label="Top owners" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
            {rows.map((row, i) => {
              const breadth = teamBreadth(row);
              return (
                <tr
                  key={row.component}
                  className={`${i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-800/40'} hover:bg-purple-50/30 dark:hover:bg-purple-900/10 transition-colors`}
                >
                  <td className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white">{row.component}</td>
                  <td className="px-4 py-3">
                    <PriorityBar score={roadmapScore(row)} maxScore={maxScore} />
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums text-gray-700 dark:text-gray-300">{row.instances.toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">{row.fileCount}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
                      breadth >= 4 ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                        : breadth >= 2 ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {Math.max(breadth, 1)} team{Math.max(breadth, 1) !== 1 ? 's' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <SourceCell canonicalSource={row.canonicalSource} componentName={row.component} project={project} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {teamsDisplay(row.codeOwners)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-gray-400 dark:text-gray-500">
                  No candidates match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Info popover ─────────────────────────────────────────────────────────────

function InfoPopover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="More information"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 focus:outline-none transition-colors"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
          <path fillRule="evenodd" clipRule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-2.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 8 5.5ZM8 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
        </svg>
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 bottom-full right-0 mb-2 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-xs text-gray-600 dark:text-gray-300 leading-relaxed"
        >
          {children}
          {/* Arrow */}
          <div className="absolute top-full right-3 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-gray-200 dark:border-t-gray-700" />
          <div className="absolute top-full right-[13px] w-0 h-0 border-x-[3px] border-x-transparent border-t-[3px] border-t-white dark:border-t-gray-800" />
        </div>
      )}
    </div>
  );
}

// ─── One-off trend chart (Target 6) ──────────────────────────────────────────

function OneoffTrendChart({ timeline }: { timeline: UntrackedProjectTimeline; project: string }) {
  const chartData = timeline.dates.map((date, i) => ({
    date,
    replaceable: timeline.replaceableInstances[i] ?? 0,
    candidates: timeline.candidateInstances[i] ?? 0,
    total: (timeline.replaceableInstances[i] ?? 0) + (timeline.candidateInstances[i] ?? 0),
    trueAdoption: timeline.trueAdoption[i] ?? null,
  }));

  if (chartData.length < 2) return null;

  // Compute a simple linear trend for the "total one-off instances" line
  const n = chartData.length;
  const latestTotal = chartData[n - 1].total;
  const prevTotal = chartData[n > 4 ? n - 5 : 0].total;
  const weekSpan = n > 4 ? 4 : n - 1;
  const weeklyChange = weekSpan > 0 ? Math.round((latestTotal - prevTotal) / weekSpan) : 0;
  const isFlat = Math.abs(weeklyChange) <= 2;
  const trend = isFlat ? 'flat' : weeklyChange < 0 ? 'down' : 'up';
  const trendTooltip = `Smoothed average over the last ${weekSpan} week${weekSpan !== 1 ? 's' : ''}: `
    + `${latestTotal.toLocaleString()} instances now vs ${prevTotal.toLocaleString()} then`
    + (isFlat ? `. A rounded average of ±${Math.abs(weeklyChange)} is treated as flat — use the weekly change chart below for week-by-week detail.` : '.');

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow p-3 text-xs">
        <p className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{label}</p>
        {payload.map((p: any) => (
          <p key={p.dataKey} style={{ color: p.color }} className="mb-0.5">
            {p.name}: {p.value != null ? (p.dataKey === 'trueAdoption' ? `${p.value.toFixed(1)}%` : p.value.toLocaleString()) : '—'}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-5 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">
            One-off component trend
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Total replaceable + candidate instances over time. A falling line means the one-off backlog is shrinking.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
            trend === 'down'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : trend === 'up'
              ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
          }`}>
            {trend === 'down' ? '↓' : trend === 'up' ? '↑' : '→'}
            {' '}
            {trend === 'flat'
              ? '~flat (4-week avg)'
              : `${Math.abs(weeklyChange)} instances/week ${trend === 'down' ? 'reduction' : 'increase'}`}
          </div>
          <InfoPopover>
            <p className="font-semibold text-gray-800 dark:text-gray-100 mb-1.5">How this is calculated</p>
            <p className="mb-1.5">
              This badge shows a <span className="font-medium text-gray-800 dark:text-gray-100">smoothed 4-week average</span> rate of change,
              not a single week-over-week diff. It compares the total one-off instance count
              now ({latestTotal.toLocaleString()}) against {weekSpan} week{weekSpan !== 1 ? 's' : ''} ago ({prevTotal.toLocaleString()}),
              then divides by {weekSpan}.
            </p>
            <p className="mb-1.5">
              <span className="font-medium text-gray-800 dark:text-gray-100">~flat</span> is shown when the rounded average is ±2 or fewer
              instances per week — at this scale that's noise, not signal.
            </p>
            <p className="text-gray-400 dark:text-gray-500">
              For week-by-week detail, see the <span className="font-medium text-gray-600 dark:text-gray-300">weekly change</span> chart below.
            </p>
          </InfoPopover>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 4, right: 60, left: 0, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-gray-100 dark:stroke-gray-700" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10 }}
            angle={-40}
            textAnchor="end"
            height={48}
          />
          <YAxis yAxisId="left" tick={{ fontSize: 10 }} width={48} />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 10 }}
            width={36}
            domain={[0, 100]}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />

          <Line
            yAxisId="left"
            type="monotone"
            dataKey="replaceable"
            name="Replaceable instances"
            stroke="#10b981"
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="candidates"
            name="Candidate instances"
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="total"
            name="Total one-off instances"
            stroke="#f59e0b"
            strokeWidth={2.5}
            strokeDasharray="5 3"
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="trueAdoption"
            name="Overall adoption %"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── One-off instances — weekly delta sparkline ───────────────────────────────

function OneoffDeltaSparkline({ timeline, project }: { timeline: UntrackedProjectTimeline; project: string }) {
  const totals = timeline.replaceableInstances.map((v, i) => v + (timeline.candidateInstances[i] ?? 0));
  const replDeltas = timeline.replaceableInstances.map((v, i) => i === 0 ? 0 : v - timeline.replaceableInstances[i - 1]).slice(1);
  const candDeltas = timeline.candidateInstances.map((v, i) => i === 0 ? 0 : v - timeline.candidateInstances[i - 1]).slice(1);
  const totalDeltas = totals.map((v, i) => i === 0 ? 0 : v - totals[i - 1]).slice(1);
  const dates = timeline.dates.slice(1);

  const allChartData = totalDeltas.map((delta, i) => ({
    date: dates[i],
    delta,
    replaceable: replDeltas[i] ?? 0,
    candidates: candDeltas[i] ?? 0,
  }));

  // Cap to last 26 weeks (~6 months)
  const chartData = allChartData.slice(-26);

  if (chartData.length === 0) return null;

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const isGood = d.delta < 0;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow p-2.5 text-xs">
        <p className="text-gray-500 dark:text-gray-400 mb-1">{d.date}</p>
        <p className={`font-semibold ${isGood ? 'text-emerald-600 dark:text-emerald-400' : d.delta === 0 ? 'text-gray-500' : 'text-red-500 dark:text-red-400'}`}>
          {d.delta > 0 ? `+${d.delta}` : d.delta} total one-off instances
        </p>
        <p className="text-gray-400 dark:text-gray-500 mt-0.5">
          Replaceable: {d.replaceable > 0 ? `+${d.replaceable}` : d.replaceable}
          {' · '}
          Candidates: {d.candidates > 0 ? `+${d.candidates}` : d.candidates}
        </p>
        <p className="text-gray-400 dark:text-gray-500 mt-0.5">
          {isGood ? 'Week-over-week reduction' : d.delta === 0 ? 'No change' : 'Net increase — new one-off usage added'}
        </p>
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-5 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
            {project === 'mobile' ? '📱' : '🧩'} One-off instances — weekly change
          </h4>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Green bars = net reduction (one-offs shrinking). Red bars = net increase (new one-off usage added).
            Hover for replaceable vs candidate breakdown.
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block bg-emerald-500" />
            reduction
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block bg-red-400" />
            increase
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={100}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-gray-100 dark:stroke-gray-700" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" height={36} />
          <YAxis tick={{ fontSize: 10 }} width={36} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="#9ca3af" strokeWidth={1} />
          <Bar dataKey="delta" radius={[2, 2, 0, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.delta < 0 ? '#10b981' : entry.delta === 0 ? '#d1d5db' : '#f87171'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Project section ──────────────────────────────────────────────────────────

function ProjectSection({ data, timeline, migrationPct }: {
  data: UntrackedData;
  timeline: UntrackedProjectTimeline | null;
  /** Migration % from the main scanner (index.js / timeline.json). Used as the authoritative base. */
  migrationPct: number | null;
}) {
  const [teamFilter, setTeamFilter] = useState('');
  const [replaceSearch, setReplaceSearch] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [replaceSort, setReplaceSort] = useState<SortState<ReplaceSortField>>({ field: 'priority', dir: 'desc' });
  const [candidateSort, setCandidateSort] = useState<SortState<CandidateSortField>>({ field: 'breadth', dir: 'desc' });

  const teams = useMemo(
    () => (data.teams ?? []).filter(t => t !== '@unknown'),
    [data.teams],
  );

  // All counts are strict local-oneoff only
  const replaceableRows = useMemo(() => data.replaceableWithMMDS.filter(isOneoffReplaceable), [data.replaceableWithMMDS]);
  const candidateRows = useMemo(() => data.futureDSCandidates.filter(isDSCandidate), [data.futureDSCandidates]);

  const replaceableInstances = useMemo(() => replaceableRows.reduce((s, r) => s + r.instances, 0), [replaceableRows]);
  const candidateInstances = useMemo(() => candidateRows.reduce((s, r) => s + r.instances, 0), [candidateRows]);

  // Migration % comes from the main scanner (index.js / timeline.json) — authoritative source.
  // Overall adoption extends migration by adding one-off instances to the denominator.
  const { trackedMMDS, trackedDeprecated } = data.summary;
  const migrationRate = migrationPct !== null ? migrationPct.toFixed(1) : '—';

  // Overall adoption: MMDS / (MMDS + deprecated + one-off replaceable + one-off candidate instances)
  // Uses untracked scanner's MMDS/deprecated counts as the best available approximation when
  // migrationPct is unavailable, otherwise derives from the main scanner total.
  const trueTotal = trackedMMDS + trackedDeprecated + replaceableInstances + candidateInstances;
  const trueAdoptionRate = trueTotal > 0 ? ((trackedMMDS / trueTotal) * 100).toFixed(1) : '—';

  // Gap: how much lower is overall adoption than the migration rate?
  const adoptionGap = migrationPct !== null && trueAdoptionRate !== '—'
    ? (migrationPct - parseFloat(trueAdoptionRate)).toFixed(1)
    : '—';

  // Teams that actually have local one-off components
  const teamsWithOneoffs = useMemo(() => {
    const owners = new Set<string>();
    [...replaceableRows, ...candidateRows].forEach(row => {
      Object.keys(row.codeOwnerBreakdown ?? {}).forEach(o => {
        if (o !== '@unknown') owners.add(o);
      });
    });
    return owners.size;
  }, [replaceableRows, candidateRows]);

  function toggleReplaceSort(field: ReplaceSortField) {
    setReplaceSort(prev =>
      prev.field === field
        ? { field, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { field, dir: field === 'confidence' ? 'asc' : 'desc' },
    );
  }

  function toggleCandidateSort(field: CandidateSortField) {
    setCandidateSort(prev =>
      prev.field === field
        ? { field, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { field, dir: 'desc' },
    );
  }

  const filteredReplaceable = useMemo(
    () => sortReplaceable(filterReplaceableRows(data.replaceableWithMMDS, teamFilter, replaceSearch), replaceSort),
    [data.replaceableWithMMDS, teamFilter, replaceSearch, replaceSort],
  );

  const filteredCandidates = useMemo(
    () => sortCandidates(filterCandidateRows(data.futureDSCandidates, teamFilter, candidateSearch), candidateSort),
    [data.futureDSCandidates, teamFilter, candidateSearch, candidateSort],
  );

  return (
    <section className="mb-12">
      {/* Section header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white capitalize flex items-center gap-3">
          {data.project === 'mobile' ? '📱' : '🧩'} {data.project}
        </h2>
        <span className="text-sm text-gray-400 dark:text-gray-500">{data.date}</span>
      </div>

      {/* Migration vs Adoption callout */}
      <div className="mb-5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-5">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Migration</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{migrationRate}%</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">MMDS ÷ (MMDS + deprecated)</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Legacy DS → MMDS progress</p>
          </div>
          <div className="text-gray-300 dark:text-gray-600 text-lg">vs</div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Overall adoption</p>
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{trueAdoptionRate}%</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">MMDS ÷ (MMDS + deprecated + one-offs)</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">All component usage</p>
          </div>
        </div>
        <div className="flex-1 min-w-[180px] text-sm text-gray-500 dark:text-gray-400 border-l border-gray-200 dark:border-gray-700 pl-5 space-y-1">
          <p>
            <span className="font-semibold text-gray-700 dark:text-gray-200">Migration</span> tracks only the swap from the old deprecated library to MMDS — it ignores custom one-off components entirely.
          </p>
          <p>
            <span className="font-semibold text-gray-700 dark:text-gray-200">Overall adoption</span> adds those one-offs to the denominator, lowering the rate by{' '}
            <span className="font-semibold text-amber-600 dark:text-amber-400">{adoptionGap} pp</span>.
            The {replaceableInstances.toLocaleString()} replaceable instances below are what's driving that gap.
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <SummaryCard
          title="Replace Now"
          value={replaceableRows.length}
          subtitle={`${replaceableInstances.toLocaleString()} instances · MMDS equivalent exists`}
          accent="green"
        />
        <SummaryCard
          title="Introduce to MMDS"
          value={candidateRows.length}
          subtitle={`${candidateInstances.toLocaleString()} instances · no DS equivalent yet`}
          accent="purple"
        />
        <SummaryCard
          title="Teams with one-offs"
          value={teamsWithOneoffs}
          subtitle="Teams owning replaceable or candidate components"
          accent="blue"
        />
        <SummaryCard
          title="Adoption gap"
          value={adoptionGap !== '—' ? `${adoptionGap} pp` : '—'}
          subtitle={`Migration ${migrationRate}% vs overall adoption ${trueAdoptionRate}% — driven by replaceable one-offs`}
          accent="amber"
        />
      </div>

      {/* Team filter */}
      {teams.length > 0 && (
        <div className="flex items-center gap-3 mb-5 px-4 py-3 bg-white dark:bg-gray-800 rounded-lg shadow">
          <span className="text-sm text-gray-500 dark:text-gray-400">Filter by team:</span>
          <select
            value={teamFilter}
            onChange={e => setTeamFilter(e.target.value)}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All teams</option>
            {teams.map(t => <option key={t} value={t}>{formatTeam(t)}</option>)}
          </select>
          {teamFilter && (
            <button
              type="button"
              onClick={() => setTeamFilter('')}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* One-off trend chart */}
      {timeline && <OneoffTrendChart timeline={timeline} project={data.project} />}

      {/* Weekly delta sparkline */}
      {timeline && <OneoffDeltaSparkline timeline={timeline} project={data.project} />}

      {/* Spacer */}
      {timeline && <div className="mb-6" />}

      {/* Tables */}
      <div className="space-y-6">
        <ReplaceNowTable
          rows={filteredReplaceable}
          project={data.project}
          search={replaceSearch}
          onSearch={setReplaceSearch}
          sort={replaceSort}
          onSort={toggleReplaceSort}
        />
        <DSRoadmapTable
          rows={filteredCandidates}
          project={data.project}
          search={candidateSearch}
          onSearch={setCandidateSearch}
          sort={candidateSort}
          onSort={toggleCandidateSort}
        />
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function UntrackedComponents() {
  const { data: mobileData, loading: mobileLoading, error: mobileError } = useUntrackedData('mobile');
  const { data: extensionData, loading: extensionLoading, error: extensionError } = useUntrackedData('extension');
  const { data: untrackedTimeline } = useUntrackedTimeline();
  // Main scanner data — authoritative source for migration %
  const { data: mobileMetrics } = useMetricsData('mobile');
  const { data: extensionMetrics } = useMetricsData('extension');

  const mobileMigrationPct = mobileMetrics
    ? parseFloat(mobileMetrics.summary.migrationPercentage)
    : null;
  const extensionMigrationPct = extensionMetrics
    ? parseFloat(extensionMetrics.summary.migrationPercentage)
    : null;

  const loading = mobileLoading || extensionLoading;
  const error = mobileError || extensionError;

  if (loading) return <Loading />;
  if (error) return <ErrorMessage error={error} />;
  if (!mobileData && !extensionData) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
        <div className="max-w-7xl mx-auto text-center py-20">
          <p className="text-gray-500 dark:text-gray-400 text-lg">No one-off component data available yet.</p>
          <p className="text-gray-400 dark:text-gray-500 text-sm mt-2">
            Run{' '}
            <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">yarn discover:extension</code>
            {' '}and{' '}
            <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">yarn discover:mobile</code>
            {' '}to generate data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-1">
            One-off Components
          </h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-3xl">
            Custom components built in-repo that bypass the Design System — platform primitives and third-party packages are excluded. Use <span className="font-medium text-gray-700 dark:text-gray-200">Replace with MMDS today</span> to find migration opportunities, and <span className="font-medium text-gray-700 dark:text-gray-200">Introduce to MMDS</span> to inform the DS roadmap.
          </p>
          <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
            <span className="font-medium text-gray-500 dark:text-gray-400">Priority score</span> = instances × confidence weight (exact ×3, strong ×2, partial ×1).{' '}
            <span className="font-medium text-gray-500 dark:text-gray-400">Breadth signal</span> = instances × unique teams.
          </p>
        </header>

        {mobileData && <ProjectSection data={mobileData} timeline={untrackedTimeline?.mobile ?? null} migrationPct={mobileMigrationPct} />}
        {extensionData && <ProjectSection data={extensionData} timeline={untrackedTimeline?.extension ?? null} migrationPct={extensionMigrationPct} />}
      </div>
    </div>
  );
}
