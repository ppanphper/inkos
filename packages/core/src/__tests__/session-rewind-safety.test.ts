import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTranscriptEvents, readTranscriptEvents } from "../interaction/session-transcript.js";
import { captureWorkCheckpoint } from "../interaction/work-checkpoint.js";
import { applySessionRewind, planSessionRewind, SessionRewindError } from "../interaction/session-rewind.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";

const SESSION = "1794880541360-redteam";
const SESSION_B = "1794880541361-redteam";
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const ORIGINAL = "original body\n";

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant", content: [{ type: "text", text }], provider: "openai", api: "openai-completions",
    model: "fixture", usage, stopReason: "stop", timestamp,
  };
}

describe("session rewind safety", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-redteam-rewind-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createSession(sessionId = SESSION, workId: string | null = "w1"): Promise<void> {
    await appendTranscriptEvents(root, sessionId, ({ nextSeq }) => [{
      type: "session_created", version: 1, sessionId, seq: nextSeq, timestamp: 1,
      bookId: null, sessionKind: workId ? "work" : "chat", workId, title: null, createdAt: 1, updatedAt: 1,
    }]);
  }

  async function startRequest(requestId: string, input: string, sessionId = SESSION): Promise<void> {
    const workCheckpoint = await captureWorkCheckpoint(root, "w1");
    await appendTranscriptEvents(root, sessionId, ({ nextSeq }) => {
      const timestamp = Date.now();
      return [{
        type: "request_started", version: 1, sessionId, requestId, seq: nextSeq, timestamp, input,
        ...(workCheckpoint ? { workCheckpoint } : {}),
      }, {
        type: "message", version: 1, sessionId, requestId, uuid: `${requestId}-user`, parentUuid: null,
        seq: nextSeq + 1, role: "user", timestamp, message: { role: "user", content: input, timestamp },
      }];
    });
  }

  async function finishRequest(requestId: string, reply: string, sessionId = SESSION): Promise<void> {
    const workCheckpoint = await captureWorkCheckpoint(root, "w1");
    await appendTranscriptEvents(root, sessionId, ({ nextSeq }) => {
      const timestamp = Date.now();
      return [{
        type: "message", version: 1, sessionId, requestId, uuid: `${requestId}-assistant`,
        parentUuid: `${requestId}-user`, seq: nextSeq, role: "assistant", timestamp, message: assistant(reply, timestamp),
      }, {
        type: "request_committed", version: 1, sessionId, requestId, seq: nextSeq + 1, timestamp,
        ...(workCheckpoint ? { workCheckpoint } : {}),
      }];
    });
  }

  async function createWork(): Promise<void> {
    await saveWorkManifest(root, createWorkManifest({ id: "w1", title: "Fixture", profileId: "script", language: "zh" }));
    await mkdir(join(root, "works/w1/source"), { recursive: true });
    await writeWorkFiles({ "script.md": ORIGINAL });
  }

  async function writeWorkFiles(files: Record<string, string>): Promise<void> {
    await syncWorkSourceArtifacts({
      projectRoot: root, workId: "w1", accept: true,
      writes: Object.entries(files).map(([path, content]) => ({ relativePath: `works/w1/source/${path}`, content })),
    });
  }

  const sourceText = (path: string) => readFile(join(root, "works/w1/source", path), "utf-8");
  const exists = (path: string) => stat(join(root, "works/w1/source", path)).then(() => true, () => false);

  // Edits made while a request runs cannot be told apart from the request's own
  // changes, so the rewind lists them and keeps the replaced content in a backup.

  it("keeps a hand edit saved during a running request in the rewind backup", async () => {
    await createWork();
    await createSession();
    await startRequest("r1", "改一下开头");
    await writeWorkFiles({ "script.md": "author hand edit, must survive\n" });
    await finishRequest("r1", "好的");

    const plan = await planSessionRewind(root, SESSION, { requestId: "r1" });
    expect(plan.work).toMatchObject({ status: "available", changes: [{ path: "script.md", action: "restore" }] });
    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    expect(await sourceText("script.md")).toBe(ORIGINAL);
    expect(result.backupPath).toMatch(/^\.inkos\/rewind-backups\//);
    expect(await readFile(join(root, result.backupPath!, "works/w1/source/script.md"), "utf-8"))
      .toBe("author hand edit, must survive\n");
    const events = await readTranscriptEvents(root, SESSION);
    expect(events.at(-1)).toMatchObject({ type: "requests_rewound", backupPath: result.backupPath });
  });

  it("keeps a file created during a running request in the rewind backup", async () => {
    await createWork();
    await createSession();
    await startRequest("r1", "写个备注");
    await writeWorkFiles({ "author-notes.md": "my private notes\n" });
    await finishRequest("r1", "好的");

    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    expect(await exists("author-notes.md")).toBe(false);
    expect(await readFile(join(root, result.backupPath!, "works/w1/source/author-notes.md"), "utf-8")).toBe("my private notes\n");
  });

  it("does not create a backup when no file is restored", async () => {
    await createWork();
    await createSession();
    await startRequest("r1", "只聊天");
    await finishRequest("r1", "好的");

    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    expect(result.backupPath).toBeUndefined();
  });

  // ---- Rewind racing with another session / a running request on the same Work ----

  it("refuses to restore files while the host reports the Work busy, but still rewinds the conversation", async () => {
    await createWork();
    await createSession(SESSION);
    await startRequest("a1", "第一条", SESSION);
    await writeWorkFiles({ "script.md": "A agent output\n" });
    await finishRequest("a1", "完成", SESSION);
    await createSession(SESSION_B);
    await startRequest("b1", "另一个会话仍在写", SESSION_B); // still open, no finishRequest

    const busyWorks: string[] = [];
    const isWorkBusy = (workId: string) => { busyWorks.push(workId); return true; };
    const error = await applySessionRewind(root, SESSION, { target: { requestId: "a1" }, restoreWork: true, isWorkBusy })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionRewindError);
    expect((error as SessionRewindError).code).toBe("REWIND_WORK_BUSY");
    expect(busyWorks).toEqual(["w1"]);
    expect(await sourceText("script.md")).toBe("A agent output\n");
    expect((await readTranscriptEvents(root, SESSION)).some((event) => event.type === "requests_rewound")).toBe(false);

    const conversationOnly = await applySessionRewind(root, SESSION, { target: { requestId: "a1" }, restoreWork: false, isWorkBusy });
    expect(conversationOnly.workRestored).toBe(false);
    expect(await sourceText("script.md")).toBe("A agent output\n");
  });

  it("no half-applied rewind across 25 rounds with a concurrent new request", async () => {
    let partial = 0;
    let rejected = 0;
    for (let round = 0; round < 25; round += 1) {
      await rm(root, { recursive: true, force: true });
      root = await mkdtemp(join(tmpdir(), "inkos-redteam-race-"));
      await createWork();
      await createSession();
      await startRequest("r1", "第一条");
      await writeWorkFiles({ "script.md": `round ${round} agent\n` });
      await finishRequest("r1", "完成");

      const rewind = applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });
      const newcomer = startRequest(`r-new-${round}`, "并发的新消息");
      const [outcome] = await Promise.allSettled([rewind, newcomer]);
      if (outcome.status === "rejected") rejected += 1;

      const events = await readTranscriptEvents(root, SESSION);
      const rewound = events.some((event) => event.type === "requests_rewound");
      const restored = (await sourceText("script.md")) === ORIGINAL;
      if (restored && !rewound) partial += 1;
    }
    // rejected counts STALE outcomes (informational); only a restored-without-event state is a failure.
    expect({ partial, rejected }).toEqual({ partial: 0, rejected: expect.any(Number) });
  });

  // ---- Protection checks ----

  it("files created after the checkpoint are removed and files deleted after it are restored", async () => {
    await createWork();
    await writeWorkFiles({ "notes.md": "keep me\n" });
    await createSession();
    await startRequest("r1", "整理");
    await writeWorkFiles({ "new.md": "agent made this\n" });
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(join(root, "works/w1/source/notes.md"));
    await finishRequest("r1", "完成");

    const result = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });

    expect(result.work.status).toBe("available");
    expect(await exists("new.md")).toBe(false);
    expect(await sourceText("notes.md")).toBe("keep me\n");
  });

  it("a request without checkpoints cannot restore files", async () => {
    await createWork();
    await appendTranscriptEvents(root, SESSION, ({ nextSeq }) => [{
      type: "session_created", version: 1, sessionId: SESSION, seq: nextSeq, timestamp: 1,
      bookId: null, sessionKind: "work", workId: "w1", title: null, createdAt: 1, updatedAt: 1,
    }]);
    await appendTranscriptEvents(root, SESSION, ({ nextSeq }) => [{
      type: "request_started", version: 1, sessionId: SESSION, requestId: "old", seq: nextSeq, timestamp: 1, input: "旧消息",
    }, {
      type: "message", version: 1, sessionId: SESSION, requestId: "old", uuid: "old-user", parentUuid: null,
      seq: nextSeq + 1, role: "user", timestamp: 1, message: { role: "user", content: "旧消息", timestamp: 1 },
    }, {
      type: "request_committed", version: 1, sessionId: SESSION, requestId: "old", seq: nextSeq + 2, timestamp: 1,
    }]);
    await writeWorkFiles({ "script.md": "changed\n" });

    const error = await applySessionRewind(root, SESSION, { target: { requestId: "old" }, restoreWork: true })
      .then(() => null, (caught: unknown) => caught);

    expect((error as SessionRewindError).code).toBe("REWIND_WORK_UNAVAILABLE");
    expect(await sourceText("script.md")).toBe("changed\n");
  });

  it("a second rewind after a restoring rewind and a new turn still restores the right baseline", async () => {
    await createWork();
    await createSession();
    await startRequest("r1", "第一条");
    await writeWorkFiles({ "script.md": "after r1\n" });
    await finishRequest("r1", "完成1");
    await startRequest("r2", "第二条");
    await writeWorkFiles({ "script.md": "after r2\n" });
    await finishRequest("r2", "完成2");

    await applySessionRewind(root, SESSION, { target: { requestId: "r2" }, restoreWork: true });
    expect(await sourceText("script.md")).toBe("after r1\n");

    await startRequest("r3", "第二条修正");
    await writeWorkFiles({ "script.md": "after r3\n" });
    await finishRequest("r3", "完成3");
    await applySessionRewind(root, SESSION, { target: { requestId: "r3" }, restoreWork: true });
    expect(await sourceText("script.md")).toBe("after r1\n");

    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: true });
    expect(await sourceText("script.md")).toBe(ORIGINAL);
  });

  it("rewinding a target that was already rewound is rejected", async () => {
    await createWork();
    await createSession();
    await startRequest("r1", "第一条");
    await finishRequest("r1", "完成");
    await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: false });

    const error = await applySessionRewind(root, SESSION, { target: { requestId: "r1" }, restoreWork: false })
      .then(() => null, (caught: unknown) => caught);
    expect((error as SessionRewindError).code).toBe("REWIND_TARGET_NOT_FOUND");
  });
});
