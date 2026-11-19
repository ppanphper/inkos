import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  ArtifactManifestSchema,
  WorkManifestSchema,
  type ArtifactManifest,
  type WorkManifest,
} from "../harness/contracts.js";
import { loadWorkManifest, workDirectory, WORKS_DIRECTORY, WORK_MANIFEST_FILE } from "../harness/work-store.js";
import { StateManager } from "../state/manager.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import { runInWorkMutationQueue, withWorkMutationScope } from "../utils/work-mutation-scope.js";
import {
  appendTranscriptEvents,
  readTranscriptEvents,
  rewoundRequestIds,
  sessionWorkIdFromEvents,
} from "./session-transcript.js";
import type { TranscriptEvent, WorkCheckpointRef } from "./session-transcript-schema.js";
import {
  buildWorkCheckpoint,
  loadWorkCheckpoint,
  workCheckpointDigest,
  type WorkCheckpoint,
} from "./work-checkpoint.js";

export type SessionRewindErrorCode =
  | "SESSION_NOT_FOUND"
  | "REWIND_TARGET_NOT_FOUND"
  | "REWIND_TARGET_STALE"
  | "REWIND_WORK_UNAVAILABLE";

export interface SessionRewindTarget {
  readonly requestId?: string;
  readonly clientRequestId?: string;
}

export interface SessionRewindFileChange {
  /** Path relative to the Work's `source/` directory. */
  readonly path: string;
  readonly action: "restore" | "create" | "delete";
}

export type SessionRewindUnavailableReason =
  | "NO_CHECKPOINT"
  | "WORK_CHANGED"
  | "EXTERNAL_CHANGE"
  | "SNAPSHOT_MISSING";

export type SessionRewindWorkPlan =
  | { readonly status: "none" }
  | { readonly status: "unchanged"; readonly workId: string }
  | { readonly status: "available"; readonly workId: string; readonly changes: ReadonlyArray<SessionRewindFileChange> }
  | {
      readonly status: "unavailable";
      readonly workId?: string;
      readonly reason: SessionRewindUnavailableReason;
      readonly paths?: ReadonlyArray<string>;
    };

export interface SessionRewindPlan {
  readonly sessionId: string;
  readonly targetRequestId: string;
  /** The target request and every later request, in transcript order. */
  readonly requestIds: ReadonlyArray<string>;
  /** Visible user messages among the rewound requests. */
  readonly turnCount: number;
  readonly work: SessionRewindWorkPlan;
}

export interface SessionRewindResult extends SessionRewindPlan {
  readonly workRestored: boolean;
}

export class SessionRewindError extends Error {
  constructor(
    readonly code: SessionRewindErrorCode,
    message: string,
    readonly work?: SessionRewindWorkPlan,
  ) {
    super(message);
    this.name = "SessionRewindError";
  }
}

interface RequestRecord {
  readonly requestId: string;
  readonly clientRequestId?: string;
  readonly startSeq: number;
  readonly start?: WorkCheckpointRef;
  end?: WorkCheckpointRef;
  visibleUser: boolean;
}

interface WorkRestore {
  readonly baselineRef: WorkCheckpointRef;
  readonly writes: AtomicFileWrite[];
  readonly deletes: string[];
}

function requestRecords(events: ReadonlyArray<TranscriptEvent>): RequestRecord[] {
  const rewound = rewoundRequestIds(events);
  const records = new Map<string, RequestRecord>();
  for (const event of events) {
    if (!("requestId" in event) || rewound.has(event.requestId)) continue;
    if (event.type === "request_started") {
      records.set(event.requestId, {
        requestId: event.requestId,
        ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
        startSeq: event.seq,
        ...(event.workCheckpoint ? { start: event.workCheckpoint } : {}),
        visibleUser: false,
      });
      continue;
    }
    const record = records.get(event.requestId);
    if (!record) continue;
    if (event.type === "request_committed" || event.type === "request_failed") record.end = event.workCheckpoint;
    else if (event.type === "message" && event.role === "user" && event.visibility !== "model") record.visibleUser = true;
  }
  return [...records.values()].sort((left, right) => left.startSeq - right.startSeq);
}

function resolveRange(events: ReadonlyArray<TranscriptEvent>, target: SessionRewindTarget): RequestRecord[] {
  if (!events.some((event) => event.type === "session_created")) {
    throw new SessionRewindError("SESSION_NOT_FOUND", "Session not found.");
  }
  const records = requestRecords(events);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (!record.visibleUser) continue;
    if ((target.requestId && record.requestId === target.requestId)
      || (target.clientRequestId && record.clientRequestId === target.clientRequestId)) {
      return records.slice(index);
    }
  }
  throw new SessionRewindError("REWIND_TARGET_NOT_FOUND", "The message to rewind is no longer in this conversation.");
}

function sameRequests(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const isSqlite = (path: string) => [".db", ".sqlite"].includes(extname(path).toLowerCase());

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function changedSourcePaths(before: WorkCheckpoint | null, after: WorkCheckpoint | null): string[] {
  if (!before || !after) return [];
  return [...new Set([...Object.keys(before.source), ...Object.keys(after.source)])]
    .filter((path) => before.source[path] !== after.source[path])
    .sort();
}

/** Find registered bytes for a source path whose content had this checksum. */
async function registeredBytes(
  projectRoot: string,
  manifest: WorkManifest,
  path: string,
  checksum: string,
): Promise<Buffer | undefined> {
  const workPath = `source/${path}`;
  for (const artifact of manifest.artifacts) {
    for (const revision of artifact.revisions) {
      if (revision.checksum !== checksum || revision.path !== workPath || !revision.snapshotPath) continue;
      try {
        const bytes = await readFile(join(workDirectory(projectRoot, manifest.id), revision.snapshotPath));
        if (sha256(bytes) === checksum) return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return undefined;
}

/** Rebuild manifest fields and revision statuses exactly as the checkpoint recorded them. */
function restoreManifest(manifest: WorkManifest, baseline: WorkCheckpoint, now: string): WorkManifest | null {
  if (Object.keys(baseline.artifacts).some((id) => !manifest.artifacts.some((artifact) => artifact.id === id))) return null;
  const artifacts: ArtifactManifest[] = [];
  for (const artifact of manifest.artifacts) {
    const recorded = baseline.artifacts[artifact.id];
    const revisionIds = new Set(artifact.revisions.map((revision) => revision.id));
    if (recorded) {
      if ((recorded.current && !revisionIds.has(recorded.current))
        || recorded.candidates.some((id) => !revisionIds.has(id))) return null;
      artifacts.push(ArtifactManifestSchema.parse({
        ...artifact,
        currentRevisionId: recorded.current,
        revisions: artifact.revisions.map((revision) => ({
          ...revision,
          status: revision.id === recorded.current ? "current"
            : recorded.candidates.includes(revision.id) ? "candidate" : "superseded",
        })),
        metadata: recorded.metadata,
      }));
      continue;
    }
    const active = artifact.revisions.some((revision) => revision.status !== "superseded");
    if (!active && artifact.currentRevisionId === null) {
      artifacts.push(artifact);
      continue;
    }
    const current = artifact.revisions.find((revision) => revision.id === artifact.currentRevisionId);
    artifacts.push(ArtifactManifestSchema.parse({
      ...artifact,
      currentRevisionId: null,
      revisions: artifact.revisions.map((revision) => ({ ...revision, status: "superseded" as const })),
      metadata: { ...artifact.metadata, ...(current ? { removedAt: now, removedPath: current.path } : {}) },
    }));
  }
  return WorkManifestSchema.parse({
    ...manifest,
    title: baseline.work.title,
    status: baseline.work.status,
    lineage: baseline.work.lineage,
    metadata: baseline.work.metadata,
    artifacts,
    updatedAt: now,
  });
}

async function planWork(
  projectRoot: string,
  events: ReadonlyArray<TranscriptEvent>,
  range: ReadonlyArray<RequestRecord>,
): Promise<{ readonly work: SessionRewindWorkPlan; readonly restore?: WorkRestore }> {
  const refs = range.flatMap((record) => [record.start, record.end]);
  const known = refs.filter((ref): ref is WorkCheckpointRef => ref !== undefined);
  if (known.length === 0) {
    const workId = sessionWorkIdFromEvents(events);
    return { work: workId ? { status: "unavailable", workId, reason: "NO_CHECKPOINT" } : { status: "none" } };
  }
  const workId = known[0]!.workId;
  if (known.length !== refs.length) return { work: { status: "unavailable", workId, reason: "NO_CHECKPOINT" } };
  if (known.some((ref) => ref.workId !== workId)) return { work: { status: "unavailable", workId, reason: "WORK_CHANGED" } };

  for (let index = 0; index + 1 < range.length; index += 1) {
    const end = range[index]!.end!;
    const nextStart = range[index + 1]!.start!;
    if (end.digest === nextStart.digest) continue;
    const paths = changedSourcePaths(await loadWorkCheckpoint(projectRoot, end), await loadWorkCheckpoint(projectRoot, nextStart));
    return { work: { status: "unavailable", workId, reason: "EXTERNAL_CHANGE", paths } };
  }

  let manifest: WorkManifest;
  try {
    manifest = await loadWorkManifest(projectRoot, workId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { work: { status: "unavailable", workId, reason: "WORK_CHANGED" } };
    }
    throw error;
  }
  const current = await buildWorkCheckpoint(projectRoot, manifest);
  const last = range.at(-1)!.end!;
  if (workCheckpointDigest(current) !== last.digest) {
    const paths = changedSourcePaths(await loadWorkCheckpoint(projectRoot, last), current);
    return { work: { status: "unavailable", workId, reason: "EXTERNAL_CHANGE", paths } };
  }

  const baselineRef = range[0]!.start!;
  if (baselineRef.digest === last.digest) return { work: { status: "unchanged", workId } };
  const baseline = await loadWorkCheckpoint(projectRoot, baselineRef);
  if (!baseline) return { work: { status: "unavailable", workId, reason: "NO_CHECKPOINT" } };

  const changes: SessionRewindFileChange[] = [];
  const writes: AtomicFileWrite[] = [];
  const deletes: string[] = [];
  const missing: string[] = [];
  const paths = [...new Set([...Object.keys(baseline.source), ...Object.keys(current.source)])].sort();
  for (const path of paths) {
    const before = baseline.source[path];
    const after = current.source[path];
    if (before === after) continue;
    const live = join(WORKS_DIRECTORY, workId, "source", path);
    const sidecars = isSqlite(path)
      ? (await Promise.all([`${live}-wal`, `${live}-shm`].map(async (candidate) => (
          await exists(join(projectRoot, candidate)) ? [candidate] : []
        )))).flat()
      : [];
    if (before === undefined) {
      changes.push({ path, action: "delete" });
      deletes.push(live, ...sidecars);
      continue;
    }
    const bytes = await registeredBytes(projectRoot, manifest, path, before);
    if (!bytes) {
      missing.push(path);
      continue;
    }
    changes.push({ path, action: after === undefined ? "create" : "restore" });
    writes.push({ relativePath: live, content: bytes });
    deletes.push(...sidecars);
  }
  if (missing.length > 0) return { work: { status: "unavailable", workId, reason: "SNAPSHOT_MISSING", paths: missing } };

  const restoredManifest = restoreManifest(manifest, baseline, new Date().toISOString());
  if (!restoredManifest) return { work: { status: "unavailable", workId, reason: "SNAPSHOT_MISSING" } };
  writes.push({
    relativePath: join(WORKS_DIRECTORY, workId, WORK_MANIFEST_FILE),
    content: `${JSON.stringify(restoredManifest, null, 2)}\n`,
  });
  return { work: { status: "available", workId, changes }, restore: { baselineRef, writes, deletes } };
}

function withWorkLock<T>(projectRoot: string, workId: string, task: () => Promise<T>): Promise<T> {
  return runInWorkMutationQueue(`${projectRoot}\0${workId}`, () => withWorkMutationScope(
    projectRoot, workId, () => new StateManager(projectRoot).acquireBookLock(workId), task,
  ));
}

/** Describe what rewinding to before the target message would retract and restore. */
export async function planSessionRewind(
  projectRoot: string,
  sessionId: string,
  target: SessionRewindTarget,
): Promise<SessionRewindPlan> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  const range = resolveRange(events, target);
  const { work } = await planWork(projectRoot, events, range);
  return {
    sessionId,
    targetRequestId: range[0]!.requestId,
    requestIds: range.map((record) => record.requestId),
    turnCount: range.filter((record) => record.visibleUser).length,
    work,
  };
}

/**
 * Retract the target request and every later one. With `restoreWork`, the
 * Work's files and revisions return to the target request's start checkpoint
 * first; the whole rewind is refused when that is not safely possible.
 */
export async function applySessionRewind(
  projectRoot: string,
  sessionId: string,
  input: {
    readonly target: SessionRewindTarget;
    readonly restoreWork: boolean;
    readonly expectedRequestIds?: ReadonlyArray<string>;
  },
): Promise<SessionRewindResult> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  const range = resolveRange(events, input.target);
  const requestIds = range.map((record) => record.requestId);
  const stale = () => new SessionRewindError(
    "REWIND_TARGET_STALE", "The conversation changed after the preview. Review the rewind again.",
  );
  if (input.expectedRequestIds && !sameRequests(requestIds, input.expectedRequestIds)) throw stale();

  let { work } = await planWork(projectRoot, events, range);
  let restoredWork: WorkCheckpointRef | undefined;
  if (input.restoreWork && work.status === "unavailable") {
    throw new SessionRewindError("REWIND_WORK_UNAVAILABLE", "The work files cannot be restored for this rewind.", work);
  }
  if (input.restoreWork && work.status === "available") {
    await withWorkLock(projectRoot, work.workId, async () => {
      const lockedEvents = await readTranscriptEvents(projectRoot, sessionId);
      const lockedRange = resolveRange(lockedEvents, input.target);
      if (!sameRequests(lockedRange.map((record) => record.requestId), requestIds)) throw stale();
      const locked = await planWork(projectRoot, lockedEvents, lockedRange);
      if (locked.work.status !== "available" || !locked.restore) {
        throw new SessionRewindError("REWIND_WORK_UNAVAILABLE", "The work files cannot be restored for this rewind.", locked.work);
      }
      await commitAtomicFileSet({ rootDir: projectRoot, writes: locked.restore.writes, deletes: locked.restore.deletes });
      work = locked.work;
      restoredWork = locked.restore.baselineRef;
    });
  }

  await appendTranscriptEvents(projectRoot, sessionId, ({ events: latest, nextSeq }) => {
    const latestIds = resolveRange(latest, input.target).map((record) => record.requestId);
    if (!sameRequests(latestIds, requestIds)) throw stale();
    return [{
      type: "requests_rewound",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: Date.now(),
      targetRequestId: requestIds[0]!,
      requestIds,
      ...(restoredWork ? { restoredWork } : {}),
    }];
  });

  return {
    sessionId,
    targetRequestId: requestIds[0]!,
    requestIds,
    turnCount: range.filter((record) => record.visibleUser).length,
    work,
    workRestored: restoredWork !== undefined,
  };
}
