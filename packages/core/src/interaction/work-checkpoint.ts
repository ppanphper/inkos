import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkResourceIdSchema, type WorkManifest } from "../harness/contracts.js";
import { listWorkSourceFiles, readWorkSourceBytes } from "../harness/source-sync.js";
import { loadWorkManifest, workDirectory } from "../harness/work-store.js";
import { WorkCheckpointRefSchema, type WorkCheckpointRef } from "./session-transcript-schema.js";

const CHECKPOINTS_DIR = join(".inkos", "work-checkpoints");

/**
 * The Work state a request started from or ended at. Only active artifacts
 * (current or candidate revisions) are listed, so restoring a checkpoint
 * reproduces it exactly: artifacts created later become inactive.
 */
export const WorkCheckpointSchema = z.object({
  version: z.literal(1),
  workId: WorkResourceIdSchema,
  work: z.object({
    title: z.string(),
    status: z.string(),
    lineage: z.array(z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
  }).strict(),
  artifacts: z.record(z.string(), z.object({
    current: z.string().nullable(),
    candidates: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()),
  }).strict()),
  /** Source file path (relative to `source/`) to its registered-content checksum. */
  source: z.record(z.string(), z.string()),
}).strict();
export type WorkCheckpoint = z.infer<typeof WorkCheckpointSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workCheckpointDigest(checkpoint: WorkCheckpoint): string {
  return `sha256:${createHash("sha256").update(canonicalJson(checkpoint)).digest("hex")}`;
}

function checkpointPath(projectRoot: string, ref: WorkCheckpointRef): string {
  const workId = WorkResourceIdSchema.parse(ref.workId);
  return join(projectRoot, CHECKPOINTS_DIR, workId, `${ref.digest.slice("sha256:".length)}.json`);
}

export async function buildWorkCheckpoint(projectRoot: string, manifest: WorkManifest): Promise<WorkCheckpoint> {
  const artifacts: WorkCheckpoint["artifacts"] = {};
  for (const artifact of manifest.artifacts) {
    const candidates = artifact.revisions.filter((revision) => revision.status === "candidate").map((revision) => revision.id);
    if (artifact.currentRevisionId === null && candidates.length === 0) continue;
    artifacts[artifact.id] = { current: artifact.currentRevisionId, candidates, metadata: artifact.metadata };
  }
  const sourceRoot = join(workDirectory(projectRoot, manifest.id), "source");
  const source: Record<string, string> = {};
  for (const file of await listWorkSourceFiles(sourceRoot)) {
    const bytes = await readWorkSourceBytes(join(sourceRoot, file));
    source[file] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  return WorkCheckpointSchema.parse({
    version: 1,
    workId: manifest.id,
    work: { title: manifest.title, status: manifest.status, lineage: manifest.lineage, metadata: manifest.metadata },
    artifacts,
    source,
  });
}

export async function storeWorkCheckpoint(projectRoot: string, checkpoint: WorkCheckpoint): Promise<WorkCheckpointRef> {
  const ref = WorkCheckpointRefSchema.parse({ workId: checkpoint.workId, digest: workCheckpointDigest(checkpoint) });
  const path = checkpointPath(projectRoot, ref);
  try {
    await readFile(path);
    return ref;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, "utf-8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return ref;
}

/** Record the Work's current state; returns undefined when the Work does not exist. */
export async function captureWorkCheckpoint(projectRoot: string, workId: string): Promise<WorkCheckpointRef | undefined> {
  let manifest: WorkManifest;
  try {
    manifest = await loadWorkManifest(projectRoot, workId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return storeWorkCheckpoint(projectRoot, await buildWorkCheckpoint(projectRoot, manifest));
}

export async function loadWorkCheckpoint(projectRoot: string, ref: WorkCheckpointRef): Promise<WorkCheckpoint | null> {
  let raw: string;
  try {
    raw = await readFile(checkpointPath(projectRoot, ref), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const checkpoint = WorkCheckpointSchema.parse(JSON.parse(raw));
  return workCheckpointDigest(checkpoint) === ref.digest ? checkpoint : null;
}
