import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useModels, type ModelEntry } from "@/hooks/use-models";
import { cn } from "@/lib/utils";

interface Props {
  engine: string;
  value: string;
  onChange: (value: string) => void;
}

/** Provider display names for grouping */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama (local)",
  openrouter: "OpenRouter",
  unknown: "Other",
};

/** Provider display order — most relevant first */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "ollama", "openrouter", "unknown"];

/** Group models by provider, sorted by context window (largest first) */
function groupByProvider(models: ModelEntry[]): Array<[string, ModelEntry[]]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    const key = m.provider;
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  }
  // Sort within each group: largest context window first
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (b.context_window ?? 0) - (a.context_window ?? 0));
  }
  // Sort groups by provider order
  return PROVIDER_ORDER
    .filter((p) => groups[p])
    .map((p) => [p, groups[p]] as [string, ModelEntry[]]);
}

/** Format context window for display */
function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function ModelCombobox({ engine, value, onChange }: Props) {
  const { data: models, isLoading, isError } = useModels(engine);
  const [open, setOpen] = useState(false);

  // Fallback to a plain text input if fetch fails
  if (isError) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter model ID"
        className="h-10 w-full text-foreground"
      />
    );
  }

  // Resolve the engine-specific ID for display
  const resolveEngineId = (model: ModelEntry): string => {
    return model.engines[engine] ?? model.id;
  };

  // Find the currently selected model for display
  const selectedModel = models?.find(
    (m) => resolveEngineId(m) === value || m.id === value,
  );
  const displayValue = selectedModel
    ? resolveEngineId(selectedModel)
    : value || "Select a model";

  const grouped = models ? groupByProvider(models) : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        role="combobox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-lg border border-border bg-background px-2.5 text-sm text-foreground",
          "hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        <span className="truncate flex items-center gap-1.5">
          {displayValue}
          {selectedModel?.local && (
            <Badge className="bg-lime-400/15 text-lime-400 border-lime-400/30 text-[10px] px-1.5 py-0 h-4">Local</Badge>
          )}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>
              {isLoading ? "Loading models..." : "No models found."}
            </CommandEmpty>
            {grouped.map(([provider, providerModels]) => (
              <CommandGroup
                key={provider}
                heading={PROVIDER_LABELS[provider] ?? provider}
              >
                {providerModels.map((model) => {
                  const engineId = resolveEngineId(model);
                  const isSelected = engineId === value || model.id === value;
                  const ctx = formatContext(model.context_window);
                  return (
                    <CommandItem
                      key={`${model.provider}-${model.id}`}
                      value={`${model.provider} ${model.id} ${engineId}`}
                      data-checked={isSelected || undefined}
                      onSelect={() => {
                        onChange(engineId);
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between"
                    >
                      <span className="truncate flex-1 min-w-0">{engineId}</span>
                      <span className="shrink-0 flex items-center gap-1.5 ml-2">
                        {model.local && (
                          <Badge className="bg-lime-400/15 text-lime-400 border-lime-400/30 text-[10px] px-1.5 py-0 h-4">
                            Local
                          </Badge>
                        )}
                        {ctx && (
                          <span className="text-xs text-muted-foreground">{ctx}</span>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
