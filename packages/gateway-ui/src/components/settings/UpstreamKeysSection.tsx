/**
 * Upstream-key pool management — v0.5 PR3.
 *
 * Admin-only section rendered on the API Keys page. Lets the operator
 * maintain a pool of provider API keys (anthropic / openai / gemini).
 * The resolver picks LRU-active rows; 3 consecutive upstream failures
 * automatically disables a row. This UI also exposes manual
 * disable/enable/delete and an "Add key" dialog.
 *
 * Safety: keys are never returned in plaintext after creation. The
 * list view shows only a 10-char prefix.
 */
import { useState } from "react";
import { Plus, PowerOff, Power, Trash2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  useUpstreamKeys, useAddUpstreamKey, useSetUpstreamKeyDisabled, useDeleteUpstreamKey,
  type UpstreamKeyView, type UpstreamProvider,
} from "@/hooks/use-upstream-keys";

const PROVIDERS: Array<{ value: UpstreamProvider; label: string; vaultKey: string }> = [
  { value: "anthropic", label: "Anthropic", vaultKey: "ANTHROPIC_API_KEY" },
  { value: "openai",    label: "OpenAI",    vaultKey: "OPENAI_API_KEY" },
  { value: "gemini",    label: "Gemini",    vaultKey: "GEMINI_API_KEY" },
];

function timeAgo(ms: number | null): string {
  if (ms == null) return "never";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function UpstreamKeysSection() {
  const { data: keys, error } = useUpstreamKeys();
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UpstreamKeyView | null>(null);

  // Server returns 403 for non-admins; useUpstreamKeys collapses to [].
  // We only hide the section entirely when an explicit error is still set.
  if (error) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Server className="size-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">Upstream key pool</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Pool of upstream provider keys used by agents. The gateway picks
            the least-recently-used active key per provider. 3 consecutive
            failures automatically disable a row; re-enable or delete here.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)} className="gap-1.5">
          <Plus className="size-3.5" />
          Add key
        </Button>
      </div>

      {keys && keys.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Provider</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[120px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <PoolRow
                  key={k.id}
                  row={k}
                  onDelete={() => setDeleteTarget(k)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No pooled keys yet. Add one to start routing sessions through the pool.
        </p>
      )}

      <AddUpstreamKeyDialog open={addOpen} onOpenChange={setAddOpen} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete pool entry?</AlertDialogTitle>
            <AlertDialogDescription>
              In-flight sessions keep the key they already acquired. New
              sessions will select a different active row (or fall back to
              the config cascade if none remain).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <DeleteUpstreamAction
              target={deleteTarget}
              onDone={() => setDeleteTarget(null)}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Row with inline enable/disable toggle ─────────────────────────────

function PoolRow({ row, onDelete }: { row: UpstreamKeyView; onDelete: () => void }) {
  const toggle = useSetUpstreamKeyDisabled();
  const disabled = row.disabled_at != null;

  async function flip() {
    try {
      await toggle.mutateAsync({ id: row.id, disabled: !disabled });
      toast.success(disabled ? "Re-enabled" : "Disabled");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <Badge variant="secondary" className="uppercase">{row.provider}</Badge>
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs text-muted-foreground">{row.prefix}…</code>
      </TableCell>
      <TableCell>
        {disabled ? (
          <Badge variant="outline" className="text-destructive border-destructive/40">disabled</Badge>
        ) : (
          <Badge variant="outline" className="text-lime-500 border-lime-500/40">active</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{timeAgo(row.last_used_at)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{timeAgo(row.created_at)}</TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-1">
          <Button
            variant="ghost" size="icon"
            onClick={flip}
            title={disabled ? "Re-enable" : "Disable"}
          >
            {disabled ? <Power className="size-4" /> : <PowerOff className="size-4 text-destructive" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} title="Delete">
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Add dialog ────────────────────────────────────────────────────────

function AddUpstreamKeyDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [provider, setProvider] = useState<UpstreamProvider>("anthropic");
  const [value, setValue] = useState("");
  const add = useAddUpstreamKey();

  async function submit() {
    const trimmed = value.trim();
    if (trimmed.length < 20) {
      toast.error("Key value looks too short to be real");
      return;
    }
    try {
      await add.mutateAsync({ provider, value: trimmed });
      toast.success("Added");
      setValue("");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add upstream key</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="provider-select">Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as UpstreamProvider)}>
              <SelectTrigger id="provider-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map(p => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="key-value">API key</Label>
            <Input
              id="key-value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste the raw key"
              autoFocus
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Stored encrypted at rest. The key value is never returned
              after it's added — only a 10-char prefix.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!value.trim() || add.isPending}>
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUpstreamAction({ target, onDone }: { target: UpstreamKeyView | null; onDone: () => void }) {
  const del = useDeleteUpstreamKey();
  async function doDelete() {
    if (!target) return;
    try {
      await del.mutateAsync(target.id);
      toast.success("Deleted");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <AlertDialogAction onClick={doDelete} disabled={del.isPending}>
      {del.isPending ? "Deleting…" : "Delete"}
    </AlertDialogAction>
  );
}
