/**
 * GET /google/v1beta/files/environment-:envId:download
 *
 * Downloads all output files from sessions in an environment as a tar archive.
 * Google's API returns a .tar of the environment filesystem snapshot.
 * We approximate this by collecting all files scoped to sessions in the env.
 */
import { routeWrap } from "../../http";
import { badRequest, notFound } from "../../errors";
import { getDb } from "../../db/client";
import { readFile } from "../../files/storage";
import type { FileRow } from "../../db/files";

/**
 * Minimal tar archive builder — no external dependencies.
 * Produces a POSIX tar (ustar) archive in memory.
 */
function buildTarArchive(files: Array<{ name: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const header = Buffer.alloc(512, 0);
    const name = file.name.slice(0, 100);

    // name (0..100)
    header.write(name, 0, Math.min(name.length, 100), "utf8");
    // mode (100..108)
    header.write("0000644\0", 100, 8, "utf8");
    // uid (108..116)
    header.write("0000000\0", 108, 8, "utf8");
    // gid (116..124)
    header.write("0000000\0", 116, 8, "utf8");
    // size (124..136) — octal, 11 chars + null
    header.write(file.data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
    // mtime (136..148) — use current time
    const mtime = Math.floor(Date.now() / 1000);
    header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");
    // checksum placeholder (148..156) — spaces for calculation
    header.write("        ", 148, 8, "utf8");
    // typeflag (156) — '0' for regular file
    header.write("0", 156, 1, "utf8");
    // magic (257..263) — "ustar\0"
    header.write("ustar\0", 257, 6, "utf8");
    // version (263..265) — "00"
    header.write("00", 263, 2, "utf8");

    // Compute checksum: sum of all unsigned bytes in header
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

    blocks.push(header);

    // File data + padding to 512-byte boundary
    blocks.push(file.data);
    const remainder = file.data.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }

  // Two 512-byte zero blocks to mark end of archive
  blocks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(blocks);
}

export function handleGetEnvironmentFiles(request: Request, fileRef: string): Promise<Response> {
  return routeWrap(request, async () => {
    // fileRef is like "environment-env_01ABC123:download"
    // Parse out the environment ID
    const match = fileRef.match(/^environment-(.+):download$/);
    if (!match) {
      throw badRequest("Invalid file reference format. Expected: environment-<envId>:download");
    }
    const envId = match[1];

    // Verify environment exists
    const db = getDb();
    const env = db.prepare(`SELECT id FROM environments WHERE id = ?`).get(envId) as { id: string } | undefined;
    if (!env) {
      throw notFound(`environment not found: ${envId}`);
    }

    // Find all sessions in this environment
    const sessions = db.prepare(
      `SELECT id FROM sessions WHERE environment_id = ?`
    ).all(envId) as Array<{ id: string }>;

    if (sessions.length === 0) {
      // Return empty tar
      const emptyTar = Buffer.alloc(1024, 0);
      return new Response(emptyTar, {
        headers: {
          "Content-Type": "application/x-tar",
          "Content-Length": String(emptyTar.length),
        },
      });
    }

    // Find all files scoped to those sessions
    const sessionIds = sessions.map((s) => s.id);
    const placeholders = sessionIds.map(() => "?").join(",");
    const fileRows = db.prepare(
      `SELECT * FROM files WHERE scope_type = 'session' AND scope_id IN (${placeholders})`
    ).all(...sessionIds) as FileRow[];

    // Build tar archive from file data
    const tarFiles: Array<{ name: string; data: Buffer }> = [];
    for (const row of fileRows) {
      // Skip remote files (Anthropic-side files not yet downloaded)
      if (row.storage_path.startsWith("remote:")) continue;
      try {
        const data = readFile(row.storage_path);
        tarFiles.push({ name: row.filename, data });
      } catch {
        // Best effort — skip files that can't be read
      }
    }

    const tar = buildTarArchive(tarFiles);
    return new Response(tar, {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Length": String(tar.length),
      },
    });
  });
}
