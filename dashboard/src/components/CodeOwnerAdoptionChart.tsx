import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';

interface CodeOwnerStats {
  mmdsInstances: number;
  deprecatedInstances: number;
  totalInstances: number;
  migrationPercentage: string;
  filesCount: number;
}

interface CodeOwnerAdoptionChartProps {
  codeOwnerStats: Record<string, CodeOwnerStats>;
  title: string;
  /** Adoption % threshold to highlight. Default: 90 */
  threshold?: number;
}

function isUnknownOwner(owner: string) {
  const normalized = owner.replace(/^@/, '').toLowerCase();
  return normalized === 'unknown' || normalized === 'metamask/unknown';
}

function formatOwnerLabel(owner: string) {
  if (isUnknownOwner(owner)) return 'No CODEOWNERS';
  return owner.replace('@MetaMask/', '').replace(/^@/, '');
}

/** Bar fill based on migration % vs threshold. */
function barFill(pct: number, threshold: number): string {
  if (pct >= threshold) return '#10b981';   // emerald — on target
  if (pct >= threshold * 0.7) return '#f59e0b'; // amber — close
  return '#ef4444'; // red — behind
}

export function CodeOwnerAdoptionChart({ codeOwnerStats, title, threshold = 90 }: CodeOwnerAdoptionChartProps) {
  const chartData = Object.entries(codeOwnerStats)
    .map(([owner, stats]) => ({
      ownerLabel: formatOwnerLabel(owner),
      team: formatOwnerLabel(owner),
      mmdsInstances: stats.mmdsInstances,
      deprecatedInstances: stats.deprecatedInstances,
      migrationPercentage: parseFloat(stats.migrationPercentage),
      totalInstances: stats.totalInstances,
    }))
    // Sort: above-threshold teams first, then by migration % desc within each group
    .sort((a, b) => b.migrationPercentage - a.migrationPercentage);

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{title}</h3>
        <p className="text-gray-500 dark:text-gray-400">No code owner data available</p>
      </div>
    );
  }

  const compliant = chartData.filter(d => d.migrationPercentage >= threshold).length;
  const total = chartData.length;
  const pctCompliant = Math.round((compliant / total) * 100);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      const onTarget = d.migrationPercentage >= threshold;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm">
          <p className="font-semibold text-gray-900 dark:text-white mb-1">{d.ownerLabel}</p>
          <p className="text-blue-600 dark:text-blue-400">MMDS: {d.mmdsInstances.toLocaleString()}</p>
          <p className="text-orange-600 dark:text-orange-400">Deprecated: {d.deprecatedInstances.toLocaleString()}</p>
          <p className={`mt-1 font-semibold ${onTarget ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
            Adoption: {d.migrationPercentage.toFixed(1)}%
            {onTarget ? ' ✓' : ` (${(threshold - d.migrationPercentage).toFixed(1)}pp to go)`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      {/* Header + compliance card */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>

        <div className="flex gap-3">
          <div className={`rounded-lg px-4 py-2.5 text-center min-w-[120px] ${
            compliant === total
              ? 'bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200 dark:ring-emerald-700'
              : 'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-700'
          }`}>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              ≥ {threshold}% target
            </p>
            <p className={`text-2xl font-bold ${
              compliant === total ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
            }`}>
              {compliant} <span className="text-base font-normal text-gray-400">/ {total}</span>
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">teams on target</p>
          </div>
          <div className="rounded-lg px-4 py-2.5 text-center min-w-[90px] bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200 dark:ring-red-800">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Below</p>
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">{total - compliant}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">teams ({100 - pctCompliant}%)</p>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" />
          <span className="text-gray-500 dark:text-gray-400">≥ {threshold}% (on target)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" />
          <span className="text-gray-500 dark:text-gray-400">≥ {Math.round(threshold * 0.7)}% (approaching)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-red-400" />
          <span className="text-gray-500 dark:text-gray-400">&lt; {Math.round(threshold * 0.7)}% (behind)</span>
        </span>
      </div>

      <ResponsiveContainer width="100%" height={Math.max(360, chartData.length * 36)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 50, left: 100, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis
            dataKey="team"
            type="category"
            width={90}
            tick={{ fontSize: 11, fill: 'currentColor' }}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* Reference line at threshold % of max total — approximate visual guide */}
          <ReferenceLine
            x={0}
            stroke="transparent"
            label=""
          />

          <Bar dataKey="mmdsInstances" name="MMDS" stackId="a" radius={[0, 0, 0, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={barFill(entry.migrationPercentage, threshold)} opacity={0.85} />
            ))}
          </Bar>
          <Bar dataKey="deprecatedInstances" name="Deprecated" stackId="a" fill="#e5e7eb" radius={[0, 2, 2, 0]}>
            {chartData.map((_entry, i) => (
              <Cell key={i} fill="#e5e7eb" className="dark:fill-gray-600" opacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
