import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createWorkManifest,
  evictAgentCache,
  loadWorkManifest,
  saveWorkManifest,
  syncWorkSourceArtifacts,
} from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void;

const ORIGINAL = "Nora opens the gallery.\n\nThe visitor waits.\n";
const WRONG_INSTRUCTION = "WRONG-INSTRUCTION rewrite the whole script as a western";
const WRONG_DRAFT = "WRONG-DRAFT cowboys ride into town.\n";

let root: string;
let handler: Handler;
let upstream: ReturnType<typeof createServer>;
let initialRevision: string;
let sessionId: string | undefined;
const mainRequests: any[] = [];

function respondTool(res: ServerResponse, name: string, args: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }] } }] }));
}

const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const scriptPath = () => join(root, "works/gallery/source/script.md");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-session-rewind-"));
  mainRequests.length = 0;
  sessionId = undefined;
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.tools?.some((tool: any) => tool.function?.name === "finish_turn")) mainRequests.push(body);
    handler(body, req, res);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  await mkdir(join(root, ".inkos"));
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "fixture", version: "0.1.0", language: "en", llm: {
    defaultModel: "fixture", services: [{ service: "custom", name: "fixture", baseUrl, apiFormat: "chat", stream: false, models: ["fixture"] }],
  } }));
  await writeFile(join(root, ".inkos/secrets.json"), JSON.stringify({ services: { "custom:fixture": { apiKey: "fixture" } } }));
  await saveWorkManifest(root, createWorkManifest({ id: "gallery", profileId: "script", title: "Gallery", language: "en" }));
  await mkdir(join(root, "works/gallery/source"), { recursive: true });
  const original = await syncWorkSourceArtifacts({ projectRoot: root, workId: "gallery", accept: true,
    writes: [{ relativePath: "works/gallery/source/script.md", content: ORIGINAL }] });
  initialRevision = original.artifacts[0]!.currentRevisionId!;
});

afterEach(async () => {
  if (sessionId) evictAgentCache(sessionId);
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function openSession(app: ReturnType<typeof createStudioServer>) {
  const { session } = await (await app.request("/api/v1/sessions", post({ sessionKind: "work", profileId: "script", workId: "gallery" }))).json();
  sessionId = session.sessionId;
  return {
    send: (target: ReturnType<typeof createStudioServer>, instruction: string, clientRequestId: string) => target.request("/api/v1/agent", post({
      sessionId: session.sessionId, instruction, clientRequestId, workId: "gallery", profileId: "script", model: "fixture", service: "custom:fixture",
    })),
    sessionId: session.sessionId as string,
  };
}

/** The wrong turn writes the artifact, then closes the turn. */
function writeWrongDraftThenFinish(): Handler {
  let calls = 0;
  return (body, _req, res) => {
    if (!body.tools?.some((tool: any) => tool.function?.name === "finish_turn")) {
      res.writeHead(500); res.end(); return;
    }
    if (calls++ === 0) {
      respondTool(res, "workspace__replace_work_artifact", { path: "source/script.md", content: WRONG_DRAFT, expectedRevisionId: initialRevision });
      return;
    }
    respondTool(res, "finish_turn", { status: "blocked", message: "Draft replaced; awaiting review." });
  };
}

const finishOnly: Handler = (_body, _req, res) => respondTool(res, "finish_turn", { status: "blocked", message: "Noted." });

it("rewinds a wrong turn with its file change and keeps it out of the model context after a restart", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  await session.send(app, WRONG_INSTRUCTION, "wrong-1");
  expect(await readFile(scriptPath(), "utf8")).toBe(WRONG_DRAFT);

  const preview = await (await app.request(`/api/v1/sessions/${session.sessionId}/rewind/preview`, post({ clientRequestId: "wrong-1" }))).json();
  expect(preview.plan).toMatchObject({ turnCount: 1, work: { status: "available", workId: "gallery", changes: [{ path: "script.md", action: "restore" }] } });

  const rewound = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({
    clientRequestId: "wrong-1", restoreWork: true, expectedRequestIds: preview.plan.requestIds,
  }));
  expect(rewound.status).toBe(200);
  const body = await rewound.json();
  expect(body.result.workRestored).toBe(true);
  expect(JSON.stringify(body.session.messages)).not.toContain("WRONG");
  expect(await readFile(scriptPath(), "utf8")).toBe(ORIGINAL);
  expect((await loadWorkManifest(root, "gallery")).artifacts[0]!.currentRevisionId).toBe(initialRevision);

  evictAgentCache(session.sessionId);
  const restarted = createStudioServer({} as never, root);
  const detail = await (await restarted.request(`/api/v1/sessions/${session.sessionId}`)).json();
  expect(JSON.stringify(detail.session.messages)).not.toContain("WRONG");
  expect(detail.chatRequest).toBeNull();
  handler = finishOnly;
  mainRequests.length = 0;
  await session.send(restarted, "Correct instruction: tighten the second paragraph.", "fixed-1");
  const modelInput = JSON.stringify(mainRequests[0].messages);
  expect(modelInput).toContain("Correct instruction");
  expect(modelInput).not.toContain("WRONG");
}, 30000);

it("rewinds a stopped message, and refuses to rewind while the reply is still running", async () => {
  let reachedUpstream!: () => void;
  const reached = new Promise<void>((resolve) => { reachedUpstream = resolve; });
  handler = (_body, req) => { reachedUpstream(); req.on("close", () => undefined); };
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  const pending = session.send(app, "STOPPED-MESSAGE with a typo", "slow-1");
  await reached;

  const busy = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({ clientRequestId: "slow-1", restoreWork: false }));
  expect(busy.status).toBe(409);
  expect((await busy.json()).error.code).toBe("SESSION_BUSY");

  await app.request(`/api/v1/sessions/${session.sessionId}/abort`, { method: "POST" });
  await pending;
  const detail = await (await app.request(`/api/v1/sessions/${session.sessionId}`)).json();
  expect(detail.session.messages[0]).toMatchObject({ role: "user", clientRequestId: "slow-1", requestStatus: "failed" });

  const preview = await (await app.request(`/api/v1/sessions/${session.sessionId}/rewind/preview`, post({ clientRequestId: "slow-1" }))).json();
  expect(preview.plan).toMatchObject({ turnCount: 1, work: { status: "unchanged", workId: "gallery" } });
  const rewound = await (await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({
    clientRequestId: "slow-1", restoreWork: false, expectedRequestIds: preview.plan.requestIds,
  }))).json();
  expect(rewound.session.messages).toEqual([]);
}, 30000);

it("refuses to restore files edited after the turn but still rewinds the conversation", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  await session.send(app, WRONG_INSTRUCTION, "wrong-1");
  await writeFile(scriptPath(), "Author fixed this by hand.\n");

  const preview = await (await app.request(`/api/v1/sessions/${session.sessionId}/rewind/preview`, post({ clientRequestId: "wrong-1" }))).json();
  expect(preview.plan.work).toMatchObject({ status: "unavailable", reason: "EXTERNAL_CHANGE", paths: ["script.md"] });
  const refused = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({ clientRequestId: "wrong-1", restoreWork: true }));
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.code).toBe("REWIND_WORK_UNAVAILABLE");
  expect(await readFile(scriptPath(), "utf8")).toBe("Author fixed this by hand.\n");

  const rewound = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({ clientRequestId: "wrong-1", restoreWork: false }));
  expect(rewound.status).toBe(200);
  expect(await readFile(scriptPath(), "utf8")).toBe("Author fixed this by hand.\n");

  handler = finishOnly;
  mainRequests.length = 0;
  await session.send(app, "Next instruction on the same server.", "next-1");
  expect(JSON.stringify(mainRequests[0].messages)).not.toContain("WRONG-INSTRUCTION");
}, 30000);
