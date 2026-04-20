/**
 * API Throughput tab panel — stat tiles + charts from /v1/metrics/api.
 *
 * Owns its own `useApiMetrics` hook so that when this panel is
 * unmounted (inactive tab), the 5-second polling automatically pauses.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiMetrics } from "@/hooks/use-metrics";
import { Sparkline, BarList } from "./Sparkline";
import { StatTile } from "./StatTile";

function formatTimeAxis(ms: number | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ApiThroughputPanel({ windowMinutes }: { windowMinutes: number }) {
  const apiWindow = Math.min(windowMinutes, 60);
  const apiQuery = useApiMetrics({ windowMinutes: apiWindow });

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <span className="text-xs text-muted-foreground/60">
          last {apiWindow} min · in-process
        </span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile
          label="Requests"
          value={apiQuery.data?.totals.count ?? 0}
          loading={apiQuery.isLoading}
        />
        <StatTile
          label="Req / sec"
          value={(apiQuery.data?.totals.rps ?? 0).toFixed(2)}
          loading={apiQuery.isLoading}
        />
        <StatTile
          label="p50"
          value={
            apiQuery.data?.totals.p50_ms != null
              ? `${Math.round(apiQuery.data.totals.p50_ms)} ms`
              : "—"
          }
          loading={apiQuery.isLoading}
        />
        <StatTile
          label="p95"
          value={
            apiQuery.data?.totals.p95_ms != null
              ? `${Math.round(apiQuery.data.totals.p95_ms)} ms`
              : "—"
          }
          loading={apiQuery.isLoading}
        />
        <StatTile
          label="Error rate"
          value={`${((apiQuery.data?.totals.error_rate ?? 0) * 100).toFixed(1)}%`}
          loading={apiQuery.isLoading}
          tone={
            apiQuery.data && apiQuery.data.totals.error_rate > 0.01
              ? "warn"
              : "neutral"
          }
        />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-sm">Requests per minute</CardTitle>
        </CardHeader>
        <CardContent>
          <Sparkline
            data={apiQuery.data?.timeline.map((t) => t.count) ?? []}
            errors={apiQuery.data?.timeline.map((t) => t.error_count) ?? []}
            height={96}
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{formatTimeAxis(apiQuery.data?.timeline[0]?.minute_ms)}</span>
            <span>now</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By route</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              data={
                apiQuery.data?.routes.map((r) => ({
                  label: r.route,
                  value: r.count,
                  subtitle:
                    r.p95_ms != null
                      ? `p95 ${Math.round(r.p95_ms)}ms`
                      : undefined,
                })) ?? []
              }
              limit={10}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Status classes</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              data={
                apiQuery.data
                  ? [
                      {
                        label: "2xx",
                        value: apiQuery.data.totals.status_2xx,
                        color: "bg-emerald-500/15",
                      },
                      {
                        label: "3xx",
                        value: apiQuery.data.totals.status_3xx,
                        color: "bg-sky-500/15",
                      },
                      {
                        label: "4xx",
                        value: apiQuery.data.totals.status_4xx,
                        color: "bg-amber-500/15",
                      },
                      {
                        label: "5xx",
                        value: apiQuery.data.totals.status_5xx,
                        color: "bg-red-500/15",
                      },
                    ].filter((d) => d.value > 0)
                  : []
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
