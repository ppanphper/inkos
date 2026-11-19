import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendManualSessionMessages,
  appendTranscriptEvents,
  readTranscriptEvents,
} from "../interaction/session-transcript.js";
import {
  deriveBookSessionFromTranscript,
  restoreAgentMessagesFromTranscript,
} from "../interaction/session-transcript-restore.js";
import { captureWorkCheckpoint } from "../interaction/work-checkpoint.js";
import { applySessionRewind, planSessionRewind } from "../interaction/session-rewind.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

const SESSION = "1794880541360-abcdef";
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant", content: [{ type: "text", text }], provider: "openai", api: "openai-completions",
    model: "fixture", usage, stopReason: "stop", timestamp,
  };
}

describe("session rewind", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-rewind-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createSession(workId: string | null = null): Promise<void> {
    await appendTranscriptEvents(root, SESSION, ({ nextSeq }) => [{
      type: "session_created", version: 1, sessionId: SESSION, seq: nextSeq, timestamp: 1,
      bookId: null, sessionKind: workId ? "work" : "chat", workId, title: null, createdAt: 1, updatedAt: 1,
    }]);
  }

  async function startRequest(requestId: string, input: string, options: {
    readonly workId?: string;
    readonly clientRequestId?: string;
  } = {}): Promise<void> {
    const workCheckpoint = options.workId ? await captureWorkCheckpoint(root, options.workId) : undefined;
    await appendTranscriptEvents(root, SESSION, ({ nextSeq }) => {
      const timestamp = Date.now();
      return [{
        type: "request_started", version: 1, sessionId: SESSION, requestId, seq: nextSeq, timestamp, input,
        ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
        ...(workCheckpoint ? { workCheckpoint } : {}),
      }, {
        type: "message", version: 1, sessionId: SESSION, requestId, uuid: `${requestId}-user`, parentUuid: null,
        seq: nextSeq + 1, role: "user", timestamp, message: { role: "user", content: input, timestamp },
      }];
    });
  }

  async function finishRequest(requestId: string, reply: string, options: {
    readonly workId?: string;
    readonly failed?: boolean;
  } = {}): Promise<void> {
    const workCheckpoint = options.workId ? await captureWorkCheckpoint(root, options.workId) : undefined;
    await appendTranscriptEvents(root, SESSION, ({ nextSeq }) => {
      const timestamp = Date.now();
      const end = options.failed
        ? { type: "request_failed" as const, error: "This operation was aborted" }
        : { type: "request_committed" as const };
      return [{
        type: "message", version: 1, sessionId: SESSION, requestId, uuid: `${requestId}-assistant`,
        parentUuid: `${requestId}-user`, seq: nextSeq, role: "assistant", timestamp, message: assistant(reply, timestamp),
      }, {
        ...end, version: 1, sessionId: SESSION, requestId, seq: nextSeq + 1, timestamp,
        ...(workCheckpoint ? { workCheckpoint } : {}),
      }];
    });
  }

  async function createWork(files: Record<string, string>): Promise<void> {
    await saveWorkManifest(root, createWorkManifest({ id: "w1", title: "Fixture", profileId: "script", language: "zh" }));
    await mkdir(join(root, "works/w1/source"), { recursive: true });
    await syncWorkSourceArtifacts({
      projectRoot: root, workId: "w1", accept: true,
      writes: Object.entries(files).map(([path, content]) => ({ relativePath: `works/w1/source/${path}`, content })),
    });
  }

  async function writeWork(files: Record<string, string>): Promise<void> {
    await syncWorkSourceArtifacts({
      projectRoot: root, workId: "w1", accept: true,
      writes: Object.entries(files).map(([path, content]) => ({ relativePath: `works/w1/source/${path}`, content })),
    });
  }

  const source = (path: string) => readFile(join(root, "works/w1/source", path), "utf-8");

  it("hides rewound requests from the model context and the visible conversation", async () => {
    await createSession();
    await startRequest("r1", "第一条");
    await finishRequest("r1", "收到第一条");
    await startRequest("r2", "写错的指令");
    await finishRequest("r2", "按错的指令做了");
    await startRequest("r3", "继续");
    await finishRequest("r3", "继续了");

    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r2" }, restoreWork: false });

    expect(result.requestIds).toEqual(["r2", "r3"]);
    const modelText = JSON.stringify(await restoreAgentMessagesFromTranscript(root, SESSION));
    expect(modelText).toContain("第一条");
    expect(modelText).not.toContain("写错的指令");
    expect(modelText).not.toContain("继续了");
    const session = await deriveBookSessionFromTranscript(root, SESSION);
    expect(session?.messages.map((message) => message.content)).toEqual(["第一条", "收到第一条"]);
    const events = await readTranscriptEvents(root, SESSION);
    expect(events.at(-1)).toMatchObject({ type: "requests_rewound", targetRequestId: "r2", requestIds: ["r2", "r3"] });
  });

  it("recomputes the session title when the first message is rewound", async () => {
    await createSession();
    await startRequest("r1", "写错的标题");
    await finishRequest("r1", "好的");

    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: false });

    const session = await deriveBookSessionFromTranscript(root, SESSION);
    expect(session?.title).toBeNull();
    expect(session?.messages).toEqual([]);
  });

  it("labels each visible user message with its request identity and status", async () => {
    await createSession();
    await startRequest("r1", "正常的", { clientRequestId: "client-1" });
    await finishRequest("r1", "完成");
    await startRequest("r2", "被停止的", { clientRequestId: "client-2" });
    await finishRequest("r2", "", { failed: true });
    await startRequest("r3", "还在跑", { clientRequestId: "client-3" });

    const session = await deriveBookSessionFromTranscript(root, SESSION);
    const users = session?.messages.filter((message) => message.role === "user");
    expect(users).toMatchObject([
      { content: "正常的", requestId: "r1", clientRequestId: "client-1", requestStatus: "committed" },
      { content: "被停止的", requestId: "r2", clientRequestId: "client-2", requestStatus: "failed" },
      { content: "还在跑", requestId: "r3", clientRequestId: "client-3", requestStatus: "pending" },
    ]);
    const plan = await planSessionRewind(root, SESSION, { clientRequestId: "client-2" });
    expect(plan).toMatchObject({ targetRequestId: "r2", requestIds: ["r2", "r3"], turnCount: 2, work: { status: "none" } });
  });

  it("restores work files and revisions to the target request's start checkpoint", async () => {
    await createWork({ "chapters/0001.md": "原第一章\n", "story/state.md": "状态A\n" });
    const original = await loadWorkManifest(root, "w1");
    await createSession("w1");
    await startRequest("r1", "写第二章（写错了）", { workId: "w1" });
    await writeWork({ "chapters/0002.md": "错的第二章\n", "story/state.md": "状态B\n" });
    await finishRequest("r1", "写好了", { workId: "w1" });
    const startCheckpoint = (await readTranscriptEvents(root, SESSION))
      .find((event) => event.type === "request_started");

    const plan = await planSessionRewind(root, SESSION, { requestId: "r1" });
    expect(plan.work).toEqual({
      status: "available",
      workId: "w1",
      changes: [
        { path: "chapters/0002.md", action: "delete" },
        { path: "story/state.md", action: "restore" },
      ],
    });

    const result = await applySessionRewind(root, SESSION, {
      target: { requestId: "r1" }, restoreWork: true, expectedRequestIds: ["r1"],
    });

    expect(result.workRestored).toBe(true);
    expect(await source("story/state.md")).toBe("状态A\n");
    await expect(stat(join(root, "works/w1/source/chapters/0002.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await loadWorkManifest(root, "w1");
    const currentById = (manifest: typeof restored) => Object.fromEntries(
      manifest.artifacts.map((artifact) => [artifact.id, artifact.currentRevisionId]),
    );
    const expected = { ...currentById(original) };
    for (const artifact of restored.artifacts) expected[artifact.id] ??= null;
    expect(currentById(restored)).toEqual(expected);
    expect(startCheckpoint?.type === "request_started" && startCheckpoint.workCheckpoint)
      .toEqual(await captureWorkCheckpoint(root, "w1"));
    const events = await readTranscriptEvents(root, SESSION);
    expect(events.at(-1)).toMatchObject({ type: "requests_rewound", restoredWork: { workId: "w1" } });
  });

  it("restores source content that was never registered as a revision when the request started", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    await writeFile(join(root, "works/w1/source/story/state.md"), "作者改过但未登记\n");
    await createSession("w1");
    await startRequest("r1", "改状态", { workId: "w1" });
    await writeWork({ "story/state.md": "状态B\n" });
    await finishRequest("r1", "改好了", { workId: "w1" });

    expect((await planSessionRewind(root, SESSION, { requestId: "r1" })).work)
      .toEqual({ status: "available", workId: "w1", changes: [{ path: "story/state.md", action: "restore" }] });
    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    expect(await source("story/state.md")).toBe("作者改过但未登记\n");
  });

  it("refuses to restore files changed after the last request but can still rewind the conversation", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    await createSession("w1");
    await startRequest("r1", "改状态", { workId: "w1" });
    await writeWork({ "story/state.md": "状态B\n" });
    await finishRequest("r1", "改好了", { workId: "w1" });
    await writeFile(join(root, "works/w1/source/story/state.md"), "作者手动改过\n");

    const plan = await planSessionRewind(root, SESSION, { requestId: "r1" });
    expect(plan.work).toMatchObject({ status: "unavailable", reason: "EXTERNAL_CHANGE", paths: ["story/state.md"] });
    const before = await readTranscriptEvents(root, SESSION);
    await expect(applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true }))
      .rejects.toMatchObject({ code: "REWIND_WORK_UNAVAILABLE" });
    expect(await readTranscriptEvents(root, SESSION)).toEqual(before);
    expect(await source("story/state.md")).toBe("作者手动改过\n");

    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: false });
    expect(result.workRestored).toBe(false);
    expect(await source("story/state.md")).toBe("作者手动改过\n");
  });

  it("detects work changes made between this session's requests", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    await createSession("w1");
    await startRequest("r1", "改状态", { workId: "w1" });
    await writeWork({ "story/state.md": "状态B\n" });
    await finishRequest("r1", "改好了", { workId: "w1" });
    await writeWork({ "story/state.md": "其他会话改的\n" });
    await startRequest("r2", "看看", { workId: "w1" });
    await finishRequest("r2", "看过了", { workId: "w1" });

    expect((await planSessionRewind(root, SESSION, { requestId: "r1" })).work)
      .toMatchObject({ status: "unavailable", reason: "EXTERNAL_CHANGE" });
    expect((await planSessionRewind(root, SESSION, { requestId: "r2" })).work)
      .toEqual({ status: "unchanged", workId: "w1" });
  });

  it("cannot restore files for requests recorded without checkpoints", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    await createSession("w1");
    await startRequest("r1", "旧版本的请求");
    await finishRequest("r1", "好的");

    expect((await planSessionRewind(root, SESSION, { requestId: "r1" })).work)
      .toMatchObject({ status: "unavailable", reason: "NO_CHECKPOINT" });
  });

  it("rejects a stale rewind after the session moved on", async () => {
    await createSession();
    await startRequest("r1", "第一条");
    await finishRequest("r1", "好");
    const plan = await planSessionRewind(root, SESSION, { requestId: "r1" });
    await startRequest("r2", "第二条");
    await finishRequest("r2", "好");

    await expect(applySessionRewind(root, SESSION, {
      target: { requestId: "r1" }, restoreWork: false, expectedRequestIds: plan.requestIds,
    })).rejects.toMatchObject({ code: "REWIND_TARGET_STALE" });
  });

  it("rejects targets that are unknown or already rewound", async () => {
    await createSession();
    await startRequest("r1", "第一条");
    await finishRequest("r1", "好");
    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: false });

    await expect(planSessionRewind(root, SESSION, { requestId: "r1" }))
      .rejects.toMatchObject({ code: "REWIND_TARGET_NOT_FOUND" });
    await expect(planSessionRewind(root, SESSION, { requestId: "missing" }))
      .rejects.toMatchObject({ code: "REWIND_TARGET_NOT_FOUND" });
  });

  it("restores SQLite sources by content", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    const dbPath = join(root, "works/w1/source/story/memory.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE facts (text TEXT); INSERT INTO facts VALUES ('原始事实');");
    db.close();
    await syncWorkSourceArtifacts({ projectRoot: root, workId: "w1", accept: true });
    await createSession("w1");
    await startRequest("r1", "写入错误事实", { workId: "w1" });
    const writer = new DatabaseSync(dbPath);
    writer.exec("INSERT INTO facts VALUES ('错误事实');");
    writer.close();
    await syncWorkSourceArtifacts({ projectRoot: root, workId: "w1", accept: true });
    await finishRequest("r1", "写好了", { workId: "w1" });

    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    const started = (await readTranscriptEvents(root, SESSION)).find((event) => event.type === "request_started");
    expect(await captureWorkCheckpoint(root, "w1")).toEqual(started?.type === "request_started" && started.workCheckpoint);
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    expect(reader.prepare("SELECT text FROM facts").all()).toEqual([{ text: "原始事实" }]);
    reader.close();
  });

  it("records checkpoints for manually appended requests", async () => {
    await createWork({ "story/state.md": "状态A\n" });
    await createSession("w1");
    const before = await captureWorkCheckpoint(root, "w1");
    await writeWork({ "story/state.md": "状态B\n" });

    await appendManualSessionMessages(root, SESSION, [assistant("任务完成", Date.now()) as never], "", {
      startWorkCheckpoint: before,
    });

    const events = await readTranscriptEvents(root, SESSION);
    const started = events.find((event) => event.type === "request_started");
    const committed = events.find((event) => event.type === "request_committed");
    expect(started?.type === "request_started" && started.workCheckpoint).toEqual(before);
    expect(committed?.type === "request_committed" && committed.workCheckpoint)
      .toEqual(await captureWorkCheckpoint(root, "w1"));
  });
});
