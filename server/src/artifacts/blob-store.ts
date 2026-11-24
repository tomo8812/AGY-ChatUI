import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from '../db/database.js';
import { fsyncDir } from '../files/workspace.js';

export interface BlobLease {
  sha256: string;
  sizeBytes: number;
  blobPath: string;
  release: () => void;
}

export interface GcRunSummary {
  prunedRevisions: number;
  deletedBlobs: number;
  reclaimedBytes: number;
  skippedLeasedOrPinned: number;
}

const DEFAULT_KEEP_REVISIONS_PER_ARTIFACT = 50;

/**
 * Per-user content-addressed immutable blob store under `data/artifact-history/<userId>/blobs/`.
 * Guarantees lease acquisition BEFORE atomic rename publication and checks leases + pins + all DB references
 * inside the same synchronous critical section during GC (`ARCH-07`, `PERF-05`).
 */
export class PerUserBlobManager {
  private readonly activeLeases = new Map<string, number>();
  private readonly activePins = new Map<string, number>();

  constructor(
    private readonly historyRoot: string,
    private readonly maxBytesPerUser: number
  ) {
    fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
  }

  private leaseKey(userId: string, sha256: string): string {
    return `${userId}:${sha256}`;
  }

  getUserRoot(userId: string): string {
    return path.join(this.historyRoot, userId);
  }

  getUserBlobsDir(userId: string): string {
    return path.join(this.historyRoot, userId, 'blobs');
  }

  getUserStagingDir(userId: string): string {
    const dir = path.join(this.historyRoot, userId, 'staging');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  getBlobPath(userId: string, sha256: string): string {
    const clean = sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(clean)) {
      throw new Error(`Invalid blob sha256: ${sha256}`);
    }
    return path.join(this.getUserBlobsDir(userId), clean.slice(0, 2), clean);
  }

  hasBlob(userId: string, sha256: string): boolean {
    try {
      return fs.existsSync(this.getBlobPath(userId, sha256));
    } catch {
      return false;
    }
  }

  readBlob(userId: string, sha256: string): Buffer | null {
    const p = this.getBlobPath(userId, sha256);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  getActiveLeaseCount(userId: string, sha256: string): number {
    return this.activeLeases.get(this.leaseKey(userId, sha256)) ?? 0;
  }

  getActivePinCount(userId: string, sha256: string): number {
    return this.activePins.get(this.leaseKey(userId, sha256)) ?? 0;
  }

  pinBlob(userId: string, sha256: string): () => void {
    const key = this.leaseKey(userId, sha256.toLowerCase());
    this.activePins.set(key, (this.activePins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = (this.activePins.get(key) ?? 1) - 1;
      if (cur <= 0) this.activePins.delete(key);
      else this.activePins.set(key, cur);
    };
  }

  /**
   * Write blob to `.writing-<uuid>` + fsync, then in a synchronous critical section:
   *   1) Acquire activeLease (+1) FIRST
   *   2) Publish via rename + fsync(bucketDir)
   * Caller MUST call `lease.release()` ONLY after Stage T6 DB reference commit (or on abort cleanup).
   */
  putBlobWithLease(userId: string, data: Buffer): BlobLease {
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const finalPath = this.getBlobPath(userId, sha256);
    const bucketDir = path.dirname(finalPath);
    fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });

    const tmpPath = path.join(bucketDir, `.writing-${crypto.randomUUID()}`);
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let tmpCleaned = false;
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    fs.closeSync(fd);

    // Synchronous critical section: acquire lease BEFORE publishing blob path
    const key = this.leaseKey(userId, sha256);
    this.activeLeases.set(key, (this.activeLeases.get(key) ?? 0) + 1);
    try {
      if (fs.existsSync(finalPath)) {
        fs.rmSync(tmpPath, { force: true });
        tmpCleaned = true;
      } else {
        fs.renameSync(tmpPath, finalPath);
        tmpCleaned = true;
        fsyncDir(bucketDir);
      }
    } catch (err) {
      // Release lease on failure
      const cur = (this.activeLeases.get(key) ?? 1) - 1;
      if (cur <= 0) this.activeLeases.delete(key);
      else this.activeLeases.set(key, cur);
      if (!tmpCleaned) fs.rmSync(tmpPath, { force: true });
      throw err;
    }

    let released = false;
    return {
      sha256,
      sizeBytes: data.length,
      blobPath: finalPath,
      release: () => {
        if (released) return;
        released = true;
        const cur = (this.activeLeases.get(key) ?? 1) - 1;
        if (cur <= 0) this.activeLeases.delete(key);
        else this.activeLeases.set(key, cur);
      },
    };
  }

  /**
   * Collect all blob SHA256s referenced anywhere in SQLite for a user so GC never deletes live/recovery/batch/edit-request blobs.
   */
  private collectReferencedBlobs(userId: string, db: AppDatabase): Set<string> {
    const refs = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v)) refs.add(v.toLowerCase());
    };

    // 1. Active/pending artifacts
    for (const r of db.db
      .prepare("SELECT sha256 FROM artifacts WHERE user_id = ? AND lifecycle_state != 'deleted'")
      .all(userId) as Array<{ sha256: string }>) {
      add(r.sha256);
    }

    // 2. artifact_revisions
    for (const r of db.db
      .prepare('SELECT blob_sha256 FROM artifact_revisions WHERE user_id = ? AND blob_sha256 IS NOT NULL AND blob_available = 1')
      .all(userId) as Array<{ blob_sha256: string }>) {
      add(r.blob_sha256);
    }

    // 3. artifact_revision_deps
    for (const r of db.db
      .prepare('SELECT blob_sha256 FROM artifact_revision_deps WHERE user_id = ? AND blob_sha256 IS NOT NULL')
      .all(userId) as Array<{ blob_sha256: string }>) {
      add(r.blob_sha256);
    }

    // 4. Non-completed / ambiguous_quarantined commit journals
    for (const r of db.db
      .prepare("SELECT prev_blob_sha256, new_blob_sha256 FROM artifact_commit_journal WHERE user_id = ? AND state != 'aborted'")
      .all(userId) as Array<{ prev_blob_sha256: string | null; new_blob_sha256: string }>) {
      add(r.prev_blob_sha256);
      add(r.new_blob_sha256);
    }

    // 5. In-progress restore batches: all target past revisions & their dependency blobs
    for (const r of db.db
      .prepare(
        `SELECT rev.blob_sha256 AS rev_blob, dep.blob_sha256 AS dep_blob
         FROM artifact_restore_batches b
         JOIN artifact_restore_batch_items i ON i.batch_id = b.batch_id
         LEFT JOIN artifact_revisions rev ON rev.artifact_id = i.artifact_id AND rev.revision = i.target_revision
         LEFT JOIN artifact_revision_deps dep ON dep.artifact_id = i.artifact_id AND dep.revision = i.target_revision
         WHERE b.user_id = ? AND b.state = 'in_progress'`
      )
      .all(userId) as Array<{ rev_blob: string | null; dep_blob: string | null }>) {
      add(r.rev_blob);
      add(r.dep_blob);
    }

    // 6. ai_edit_requests region images
    for (const r of db.db
      .prepare('SELECT region_image_blob_sha256 FROM ai_edit_requests WHERE user_id = ? AND region_image_blob_sha256 IS NOT NULL')
      .all(userId) as Array<{ region_image_blob_sha256: string }>) {
      add(r.region_image_blob_sha256);
    }

    return refs;
  }

  /**
   * Synchronous GC pass for a user:
   * 1) Prunes old artifact revisions beyond `keepRevisionsPerArtifact` (always protecting latest revision & in_progress batch targets).
   * 2) If user blob storage exceeds `maxBytesOverride ?? this.maxBytesPerUser`, prunes oldest non-latest revisions until under budget.
   * 3) Scans user blobs directory and unlinks ONLY blobs where activeLeases===0 && activePins===0 && DB refs===0.
   */
  runGcForUser(
    userId: string,
    db: AppDatabase,
    opts: { keepRevisionsPerArtifact?: number; maxBytesOverride?: number } = {}
  ): GcRunSummary {
    const keepLimit = opts.keepRevisionsPerArtifact ?? DEFAULT_KEEP_REVISIONS_PER_ARTIFACT;
    const maxBytes = opts.maxBytesOverride ?? this.maxBytesPerUser;
    let prunedRevisions = 0;

    // Collect protected (artifact_id, revision) pairs from in_progress restore batches
    const protectedBatchTargets = new Set<string>();
    for (const row of db.db
      .prepare(
        `SELECT i.artifact_id, i.target_revision
         FROM artifact_restore_batches b
         JOIN artifact_restore_batch_items i ON i.batch_id = b.batch_id
         WHERE b.user_id = ? AND b.state = 'in_progress'`
      )
      .all(userId) as Array<{ artifact_id: string; target_revision: number }>) {
      protectedBatchTargets.add(`${row.artifact_id}:${row.target_revision}`);
    }

    // Step 1: Per-artifact revision count pruning (always protect latest revision)
    const artRows = db.db
      .prepare('SELECT id, revision FROM artifacts WHERE user_id = ?')
      .all(userId) as Array<{ id: string; revision: number }>;
    for (const art of artRows) {
      const revs = db.db
        .prepare(
          'SELECT id, revision FROM artifact_revisions WHERE artifact_id = ? AND user_id = ? ORDER BY revision DESC'
        )
        .all(art.id, userId) as Array<{ id: string; revision: number }>;
      if (revs.length > keepLimit) {
        const toPrune = revs.slice(keepLimit);
        for (const r of toPrune) {
          if (r.revision === art.revision) continue;
          if (protectedBatchTargets.has(`${art.id}:${r.revision}`)) continue;
          db.db
            .prepare('UPDATE artifact_revisions SET blob_sha256 = NULL, blob_available = 0, operation_payload_json = NULL WHERE id = ?')
            .run(r.id);
          db.db
            .prepare('DELETE FROM artifact_revision_deps WHERE artifact_id = ? AND revision = ?')
            .run(art.id, r.revision);
          prunedRevisions += 1;
        }
      }
    }

    // Step 2: Check total disk usage of user blobs and prune oldest non-latest revisions if over budget
    const listBlobFiles = (): Array<{ sha256: string; fullPath: string; size: number }> => {
      const blobsDir = this.getUserBlobsDir(userId);
      if (!fs.existsSync(blobsDir)) return [];
      const found: Array<{ sha256: string; fullPath: string; size: number }> = [];
      for (const bucket of fs.readdirSync(blobsDir, { withFileTypes: true })) {
        if (!bucket.isDirectory()) continue;
        const bDir = path.join(blobsDir, bucket.name);
        for (const entry of fs.readdirSync(bDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.writing-')) continue;
          if (!/^[a-f0-9]{64}$/i.test(entry.name)) continue;
          const fp = path.join(bDir, entry.name);
          try {
            const st = fs.statSync(fp);
            found.push({ sha256: entry.name.toLowerCase(), fullPath: fp, size: st.size });
          } catch {
            // ignore vanished
          }
        }
      }
      return found;
    };

    let blobFiles = listBlobFiles();
    let totalBytes = blobFiles.reduce((acc, b) => acc + b.size, 0);

    if (totalBytes > maxBytes) {
      // Prune oldest non-latest revisions across user's artifacts
      const oldestRevs = db.db
        .prepare(
          `SELECT r.id, r.artifact_id, r.revision, r.size_bytes
           FROM artifact_revisions r
           JOIN artifacts a ON a.id = r.artifact_id
           WHERE r.user_id = ? AND r.blob_available = 1 AND r.revision < a.revision
           ORDER BY r.created_at ASC, r.revision ASC`
        )
        .all(userId) as Array<{ id: string; artifact_id: string; revision: number; size_bytes: number }>;

      let estExcess = totalBytes - maxBytes;
      for (const r of oldestRevs) {
        if (estExcess <= 0) break;
        if (protectedBatchTargets.has(`${r.artifact_id}:${r.revision}`)) continue;
        db.db
          .prepare('UPDATE artifact_revisions SET blob_sha256 = NULL, blob_available = 0, operation_payload_json = NULL WHERE id = ?')
          .run(r.id);
        db.db
          .prepare('DELETE FROM artifact_revision_deps WHERE artifact_id = ? AND revision = ?')
          .run(r.artifact_id, r.revision);
        prunedRevisions += 1;
        estExcess -= Number(r.size_bytes);
      }
    }

    // Step 3: Synchronous critical section unlink check (leases + pins + all DB references === 0)
    const dbRefs = this.collectReferencedBlobs(userId, db);
    blobFiles = listBlobFiles();
    let deletedBlobs = 0;
    let reclaimedBytes = 0;
    let skippedLeasedOrPinned = 0;

    for (const bf of blobFiles) {
      if (dbRefs.has(bf.sha256)) continue;
      if (this.getActiveLeaseCount(userId, bf.sha256) > 0 || this.getActivePinCount(userId, bf.sha256) > 0) {
        skippedLeasedOrPinned += 1;
        continue;
      }
      try {
        fs.unlinkSync(bf.fullPath);
        deletedBlobs += 1;
        reclaimedBytes += bf.size;
      } catch {
        // ignore if already removed
      }
    }

    return {
      prunedRevisions,
      deletedBlobs,
      reclaimedBytes,
      skippedLeasedOrPinned,
    };
  }
}
