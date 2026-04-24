import { useState, useRef, useEffect } from "react";
import { Upload, Trash2, File as FileIcon, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useSession } from "@/hooks/use-sessions";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface SessionFile {
  id: string;
  filename: string;
  size: number;
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

type Tab = "output" | "uploads";

export function PlaygroundFiles({ sessionId }: Props) {
  const [tab, setTab] = useState<Tab>("output");
  const [outputFiles, setOutputFiles] = useState<SessionFile[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<(SessionFile & { resource_id?: string })[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: session } = useSession(sessionId);

  // Load output files from the Files API
  useEffect(() => {
    if (!sessionId) { setOutputFiles([]); return; }
    api<{ data: Array<{ id: string; filename: string; size: number }> }>(`/files?scope_id=${sessionId}`)
      .then(res => setOutputFiles(res.data.map(f => ({ id: f.id, filename: f.filename, size: f.size }))))
      .catch(() => {});
  }, [sessionId, session?.status]);

  // Load uploaded files from session resources
  useEffect(() => {
    if (!sessionId) { setUploadedFiles([]); return; }
    api<{ data: SessionResource[] }>(`/sessions/${sessionId}/resources`)
      .then(res => {
        const files: (SessionFile & { resource_id?: string })[] = [];
        for (const r of res.data) {
          if (r.type === "file" && r.file_id) {
            files.push({
              id: r.file_id,
              filename: r.mount_path?.split("/").pop() ?? r.file_id,
              size: 0,
              resource_id: r.id,
            });
          }
        }
        setUploadedFiles(files);
      })
      .catch(() => {});
  }, [sessionId, session?.status]);

  function handleDownload(file: SessionFile) {
    const apiKey = useAppStore.getState().apiKey;
    window.open(`/v1/files/${file.id}/content?x-api-key=${encodeURIComponent(apiKey)}`, "_blank");
  }

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
      const resource = await api<SessionResource>(`/sessions/${sessionId}/resources`, {
        method: "POST",
        body: JSON.stringify({ type: "file", file_id: uploaded.id, mount_path: uploaded.filename }),
      });
      setUploadedFiles(prev => [...prev, { ...uploaded, resource_id: resource.id }]);
      toast.success(`Attached ${uploaded.filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(file: SessionFile & { resource_id?: string }) {
    if (!sessionId) return;
    setUploadedFiles(prev => prev.filter(f => f.id !== file.id));
    try {
      if (file.resource_id) {
        await api(`/sessions/${sessionId}/resources/${file.resource_id}`, { method: "DELETE" });
      }
      toast.success(`Removed ${file.filename}`);
    } catch {
      toast.error(`Failed to remove ${file.filename}`);
      setUploadedFiles(prev => [...prev, file]);
    }
  }

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-xs text-muted-foreground/50">No session active</p>
      </div>
    );
  }

  const activeFiles = tab === "output" ? outputFiles : uploadedFiles;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        {(["output", "uploads"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 px-3 py-2 text-[11px] font-medium uppercase tracking-wider transition-colors",
              tab === t
                ? "text-foreground border-b-2 border-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "output" ? `Output (${outputFiles.length})` : `Uploads (${uploadedFiles.length})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "uploads" && (
          <>
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
              className="w-full h-7 text-xs mb-3"
              disabled={!sessionId || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                <><Loader2 className="size-3 mr-1.5 animate-spin" /> Uploading…</>
              ) : (
                <><Upload className="size-3 mr-1.5" /> Upload File</>
              )}
            </Button>
          </>
        )}

        {activeFiles.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {activeFiles.map(f => (
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
                  {tab === "uploads" && (
                    <button
                      onClick={() => handleRemove(f as SessionFile & { resource_id?: string })}
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground text-center py-4">
            {tab === "output" ? "No output files yet" : "No uploaded files"}
          </p>
        )}
      </div>
    </div>
  );
}
