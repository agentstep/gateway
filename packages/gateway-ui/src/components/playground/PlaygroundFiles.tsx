import { useState, useRef, useEffect } from "react";
import { Upload, Trash2, File as FileIcon, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useSession } from "@/hooks/use-sessions";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface SessionFile {
  id: string;
  filename: string;
  size: number;
  resource_id?: string;
}

interface SessionResource {
  id: string;
  type: string;
  file_id?: string;
  mount_path?: string;
}

interface Props {
  sessionId: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PlaygroundFiles({ sessionId }: Props) {
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession(sessionId);

  // Load files from both session resources and the Files API.
  // Re-fetches when the session goes idle (container file sync produces new files).
  useEffect(() => {
    if (!sessionId) { setFiles([]); return; }
    const seenIds = new Set<string>();
    const merged: SessionFile[] = [];

    Promise.all([
      // Session resources (uploaded/attached files)
      api<{ data: SessionResource[] }>(`/sessions/${sessionId}/resources`)
        .then(res => {
          for (const r of res.data) {
            if (r.type === "file" && r.file_id && !seenIds.has(r.file_id)) {
              seenIds.add(r.file_id);
              merged.push({ id: r.file_id, filename: r.mount_path ?? r.file_id, size: 0, resource_id: r.id });
            }
          }
        })
        .catch(() => {}),
      // Files API (synced/proxied files scoped to this session)
      api<{ data: Array<{ id: string; filename: string; size: number }> }>(`/files?scope_id=${sessionId}`)
        .then(res => {
          for (const f of res.data) {
            if (!seenIds.has(f.id)) {
              seenIds.add(f.id);
              merged.push({ id: f.id, filename: f.filename, size: f.size });
            }
          }
        })
        .catch(() => {}),
    ]).then(() => setFiles(merged));
  }, [sessionId, session?.status]);

  async function handleUpload(file: globalThis.File) {
    if (!sessionId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const apiKey = useAppStore.getState().apiKey;
      const res = await fetch(`/v1/files?scope_id=${sessionId}&scope_type=session`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: "Upload failed" } }));
        throw new Error(err.error?.message || "Upload failed");
      }
      const uploaded = await res.json() as { id: string; filename: string; size: number };

      // Attach as session resource
      const resource = await api<SessionResource>(`/sessions/${sessionId}/resources`, {
        method: "POST",
        body: JSON.stringify({ type: "file", file_id: uploaded.id, mount_path: uploaded.filename }),
      });

      setFiles(prev => [...prev, { ...uploaded, resource_id: resource.id }]);
      toast.success(`Attached ${uploaded.filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(file: SessionFile) {
    if (!sessionId) return;
    // Remove from UI immediately
    setFiles(prev => prev.filter(f => f.id !== file.id));
    try {
      if (file.resource_id) {
        await api(`/sessions/${sessionId}/resources/${file.resource_id}`, { method: "DELETE" });
      }
      toast.success(`Removed ${file.filename}`);
    } catch {
      toast.error(`Failed to remove ${file.filename}`);
      // Re-add on failure
      setFiles(prev => [...prev, file]);
    }
  }

  function handleDownload(file: SessionFile) {
    const apiKey = useAppStore.getState().apiKey;
    const url = `/v1/files/${file.id}/content`;
    // Open in a new tab with the API key as a query param for simple auth
    window.open(`${url}?x-api-key=${encodeURIComponent(apiKey)}`, "_blank");
  }

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-xs text-muted-foreground/50">No session active</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Upload button */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
          e.target.value = "";
        }}
      />
      <Button
        variant="outline"
        size="sm"
        className="w-full h-7 text-xs"
        disabled={!sessionId || uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? (
          <><Loader2 className="size-3 mr-1.5 animate-spin" /> Uploading…</>
        ) : (
          <><Upload className="size-3 mr-1.5" /> Upload File</>
        )}
      </Button>

      {/* File list */}
      {files.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {files.map(f => (
            <div key={f.id} className="flex items-center justify-between py-1.5 group">
              <div className="flex items-center gap-2 min-w-0 mr-2">
                <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs text-foreground truncate">{f.filename}</span>
                  {f.size > 0 && <span className="font-mono text-[10px] text-muted-foreground">{formatSize(f.size)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleDownload(f)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Download"
                >
                  <Download className="size-3" />
                </button>
                <button
                  onClick={() => handleRemove(f)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground text-center py-4">No output files yet</p>
      )}
    </div>
  );
}
