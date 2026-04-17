/**
 * Observability dashboard — tabbed layout.
 *
 * Two tabs, each owning its own data hook so polling pauses when the
 * tab is inactive (TabsContent unmounts by default):
 *
 *   - Agent Activity  → /v1/metrics (DB-aggregated, 15s refresh)
 *   - API Throughput   → /v1/metrics/api (in-memory ring buffer, 5s refresh)
 *
 * Tab selection persists in the URL search param `?tab=agents|api` so
 * links can be shared and browser back/forward works.
 */
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AgentActivityPanel } from "./AgentActivityPanel";
import { ApiThroughputPanel } from "./ApiThroughputPanel";

const WINDOWS = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 6 * 60 },
  { label: "24 hours", minutes: 24 * 60 },
];

export function DashboardPage() {
  const windowMinutes = useAppStore((s) => s.dashboardWindowMinutes);
  const setWindowMinutes = useAppStore((s) => s.setDashboardWindowMinutes);
  const { tab } = useSearch({ from: "/dashboard" }) as { tab: "agents" | "api" };
  const navigate = useNavigate();

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate({ to: "/dashboard", search: { tab: v as "agents" | "api" }, replace: true })
        }
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Analytics</h1>
            <TabsList className="mt-2">
              <TabsTrigger value="agents">Agent Activity</TabsTrigger>
              <TabsTrigger value="api">API Throughput</TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w.minutes}
                variant={windowMinutes === w.minutes ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setWindowMinutes(w.minutes)}
              >
                {w.label}
              </Button>
            ))}
            {tab === "api" && windowMinutes > 60 && (
              <span className="ml-2 text-xs text-muted-foreground">(capped at 60 min)</span>
            )}
          </div>
        </div>

        <TabsContent value="agents">
          <AgentActivityPanel windowMinutes={windowMinutes} />
        </TabsContent>
        <TabsContent value="api">
          <ApiThroughputPanel windowMinutes={windowMinutes} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
