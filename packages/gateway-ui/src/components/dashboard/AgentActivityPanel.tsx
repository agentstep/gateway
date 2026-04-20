/**
 * Agent Activity tab panel — stat tiles + charts from /v1/metrics.
 *
 * Owns its own `useAgentMetrics` hook so that when this panel is
 * unmounted (inactive tab), the 15-second polling automatically pauses.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentMetrics } from "@/hooks/use-metrics";
import { BarList } from "./Sparkline";
import { StatTile, formatUsd } from "./StatTile";

function LatencyStat({ label, value }: { label: string; value: number | null }) {
  return (
    <Card size="sm">
      <CardContent className="text-center">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 font-mono text-2xl tabular-nums text-foreground">
          {value != null ? `${Math.round(value)}` : "—"}
          {value != null && (
            <span className="ml-1 text-sm font-normal text-muted-foreground">ms</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function stopReasonColor(key: string): string {
  switch (key) {
    case "end_turn":
      return "bg-emerald-500/15";
    case "error":
      return "bg-red-500/15";
    case "interrupted":
      return "bg-amber-500/15";
    case "custom_tool_call":
      return "bg-sky-500/15";
    default:
      return "bg-primary/10";
  }
}

export function AgentActivityPanel({ windowMinutes }: { windowMinutes: number }) {
  const agentQuery = useAgentMetrics({
    windowMs: windowMinutes * 60_000,
    groupBy: "agent",
  });

  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Sessions"
          value={agentQuery.data?.totals.session_count ?? 0}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Turns"
          value={agentQuery.data?.totals.turn_count ?? 0}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Tool calls"
          value={agentQuery.data?.totals.tool_call_count ?? 0}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Errors"
          value={agentQuery.data?.totals.error_count ?? 0}
          loading={agentQuery.isLoading}
          tone={
            agentQuery.data && agentQuery.data.totals.error_count > 0
              ? "warn"
              : "neutral"
          }
        />
        <StatTile
          label="Cost"
          value={formatUsd(agentQuery.data?.totals.cost_usd ?? 0)}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Input tokens"
          value={agentQuery.data?.totals.input_tokens ?? 0}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Output tokens"
          value={agentQuery.data?.totals.output_tokens ?? 0}
          loading={agentQuery.isLoading}
        />
        <StatTile
          label="Cache read"
          value={agentQuery.data?.totals.cache_read_input_tokens ?? 0}
          loading={agentQuery.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Stop reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              data={
                agentQuery.data
                  ? Object.entries(agentQuery.data.stop_reasons).map(
                      ([key, value]) => ({
                        label: key,
                        value,
                        color: stopReasonColor(key),
                      }),
                    )
                  : []
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cost by agent</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              data={
                agentQuery.data?.groups
                  .filter((g) => g.cost_usd > 0)
                  .map((g) => ({
                    label: g.key,
                    value: g.cost_usd,
                    subtitle: `${g.turn_count}t`,
                  })) ?? []
              }
              formatValue={formatUsd}
            />
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">
              Tool-call latency
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (p50/p95/p99 over {agentQuery.data?.tool_call_sample_count ?? 0} samples)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <LatencyStat
                label="p50"
                value={agentQuery.data?.tool_latency_p50_ms ?? null}
              />
              <LatencyStat
                label="p95"
                value={agentQuery.data?.tool_latency_p95_ms ?? null}
              />
              <LatencyStat
                label="p99"
                value={agentQuery.data?.tool_latency_p99_ms ?? null}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
