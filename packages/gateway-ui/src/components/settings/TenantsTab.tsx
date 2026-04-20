/**
 * Tenants settings page — v0.5.
 *
 * Global-admin-only surface. Tenant users see a permission notice.
 *
 *   - List tenants (incl. the seeded `tenant_default`)
 *   - Create a new tenant (name + optional id)
 *   - Rename in place
 *   - Archive (soft delete). The default tenant is refused by the server.
 */
import { useState } from "react";
import { Pencil, Check, X, Archive, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "./PageHeader";
import { toast } from "sonner";
import {
  useTenants, useCreateTenant, useRenameTenant, useArchiveTenant,
  type Tenant,
} from "@/hooks/use-tenants";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function TenantsTab() {
  const { data: tenants, isLoading, error } = useTenants();
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Tenant | null>(null);

  // 403 + 404 are normalized to [] inside useTenants (tenant users
  // landing here see "no list" gracefully). Anything else that reaches
  // the error branch is typically 401 — an invalid/stale key — which
  // deserves a different message than a scope-mismatch.
  const errStatus = (error as { status?: number } | null | undefined)?.status;
  const showAuthError = !isLoading && error != null;
  const unauthenticated = errStatus === 401;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tenants"
        description="Isolation boundary for agents, environments, vaults, sessions, and API keys. Only global admins can manage tenants."
        actionLabel={tenants && !showAuthError ? "New tenant" : undefined}
        onAction={() => setCreateOpen(true)}
      />

      {showAuthError && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
          <AlertCircle className="mt-0.5 size-4 text-muted-foreground" />
          {unauthenticated ? (
            <p className="text-sm text-muted-foreground">
              Your API key isn't valid. Check the <code className="font-mono text-xs">x-api-key</code>
              value (or the one stored in this browser via <code className="font-mono text-xs">localStorage.ma-api-key</code>)
              matches a row in the <code className="font-mono text-xs">api_keys</code> table. A common cause is
              more than one <code className="font-mono text-xs">SEED_API_KEY</code> line in <code className="font-mono text-xs">.env</code> —
              only the last one takes effect in <code className="font-mono text-xs">process.env</code>, but only the first
              was actually seeded.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Tenant management requires a global admin API key. Your key is
              scoped to a tenant and can manage only resources within it.
            </p>
          )}
        </div>
      )}

      {tenants && tenants.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[220px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[120px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((t) => (
                <TenantRow
                  key={t.id}
                  tenant={t}
                  onArchive={() => setArchiveTarget(t)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : !showAuthError && !isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No tenants yet. Create one to start isolating resources per team.
        </p>
      ) : null}

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />

      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive tenant "{archiveTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The tenant's existing resources (agents, environments, sessions,
              vaults, keys) stay in place but no new resources can be created
              under it. This action cannot be undone through the UI.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <ArchiveTenantAction
              tenant={archiveTarget}
              onDone={() => setArchiveTarget(null)}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Row with inline rename ──────────────────────────────────────────────

function TenantRow({ tenant, onArchive }: { tenant: Tenant; onArchive: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tenant.name);
  const rename = useRenameTenant();
  const isDefault = tenant.id === "tenant_default";
  const isArchived = !!tenant.archived_at;

  async function save() {
    if (!draft.trim() || draft === tenant.name) {
      setEditing(false);
      setDraft(tenant.name);
      return;
    }
    try {
      await rename.mutateAsync({ id: tenant.id, name: draft.trim() });
      toast.success("Renamed");
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message);
      setDraft(tenant.name);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <code className="text-xs text-muted-foreground">{tenant.id}</code>
      </TableCell>
      <TableCell>
        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") { setEditing(false); setDraft(tenant.name); }
              }}
              className="h-8 text-sm"
            />
            <Button variant="ghost" size="icon" onClick={save}>
              <Check className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => { setEditing(false); setDraft(tenant.name); }}>
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <span className="text-sm text-foreground">{tenant.name}</span>
        )}
      </TableCell>
      <TableCell>
        {isArchived ? (
          <Badge variant="outline" className="text-muted-foreground">archived</Badge>
        ) : isDefault ? (
          <Badge variant="secondary">default</Badge>
        ) : (
          <Badge variant="outline" className="text-lime-500 border-lime-500/40">active</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{timeAgo(tenant.created_at)}</TableCell>
      <TableCell className="text-right">
        {!isArchived && (
          <div className="inline-flex gap-1">
            <Button
              variant="ghost" size="icon"
              onClick={() => setEditing(true)}
              title="Rename"
            >
              <Pencil className="size-4" />
            </Button>
            {!isDefault && (
              <Button
                variant="ghost" size="icon"
                onClick={onArchive}
                title="Archive"
              >
                <Archive className="size-4 text-destructive" />
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// ─── Create dialog ──────────────────────────────────────────────────────

function CreateTenantDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const create = useCreateTenant();

  async function submit() {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({
        name: name.trim(),
        id: id.trim() || undefined,
      });
      toast.success("Tenant created");
      setName("");
      setId("");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New tenant</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="tenant-name">Name</Label>
            <Input
              id="tenant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="tenant-id">
              ID <span className="text-muted-foreground">(optional, must start with <code className="text-xs">tenant_</code>)</span>
            </Label>
            <Input
              id="tenant-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="tenant_acme"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveTenantAction({ tenant, onDone }: { tenant: Tenant | null; onDone: () => void }) {
  const archive = useArchiveTenant();
  async function doArchive() {
    if (!tenant) return;
    try {
      await archive.mutateAsync(tenant.id);
      toast.success("Archived");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <AlertDialogAction onClick={doArchive} disabled={archive.isPending}>
      {archive.isPending ? "Archiving…" : "Archive"}
    </AlertDialogAction>
  );
}
