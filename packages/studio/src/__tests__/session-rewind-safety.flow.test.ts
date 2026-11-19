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

it("refuses to restore files while another session on the same Work has a running reply", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const first = await openSession(app);
  await first.send(app, WRONG_INSTRUCTION, "wrong-1");
  const firstSessionId = first.sessionId;

  let reachedUpstream!: () => void;
  const reached = new Promise<void>((resolve) => { reachedUpstream = resolve; });
  handler = (_body, req) => { reachedUpstream(); req.on("close", () => undefined); };
  const second = await openSession(app);
  const pending = second.send(app, "Another session is still writing the Gallery script.", "other-1");
  await reached;

  const rewound = await app.request(`/api/v1/sessions/${firstSessionId}/rewind`, post({
    clientRequestId: "wrong-1", restoreWork: true,
  }));
  const status = rewound.status;
  const body = await rewound.json();
  await app.request(`/api/v1/sessions/${second.sessionId}/abort`, { method: "POST" });
  await pending;
  expect(status).toBe(409);
  expect(body.error.code).toBe("REWIND_WORK_BUSY");
  expect(await readFile(scriptPath(), "utf8")).toBe(WRONG_DRAFT);
}, 30000);

it("rejects malformed expectedRequestIds instead of skipping the stale-preview guard", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  await session.send(app, WRONG_INSTRUCTION, "wrong-1");
  handler = finishOnly;
  await session.send(app, "A later turn the preview never saw.", "later-1");

  // Preview saw only wrong-1; the client sends a list with one non-string entry.
  const rewound = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({
    clientRequestId: "wrong-1", restoreWork: false, expectedRequestIds: ["not-the-real-id", 7],
  }));
  expect(rewound.status).toBe(400);
  expect((await rewound.json()).error.code).toBe("INVALID_EXPECTED_REQUEST_IDS");
  const detail = await (await app.request(`/api/v1/sessions/${session.sessionId}`)).json();
  expect(JSON.stringify(detail.session.messages)).toContain("WRONG-INSTRUCTION");
}, 30000);

it("rejects an unparseable rewind body and changes nothing", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  await session.send(app, WRONG_INSTRUCTION, "wrong-1");
  const before = await readFile(scriptPath(), "utf8");

  const broken = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  expect(broken.status).toBe(400);
  const detail = await (await app.request(`/api/v1/sessions/${session.sessionId}`)).json();
  expect(JSON.stringify(detail.session.messages)).toContain("WRONG-INSTRUCTION");
  expect(await readFile(scriptPath(), "utf8")).toBe(before);
}, 30000);

it("returns 404 for an unknown message id and changes nothing", async () => {
  handler = writeWrongDraftThenFinish();
  const app = createStudioServer({} as never, root);
  const session = await openSession(app);
  await session.send(app, WRONG_INSTRUCTION, "wrong-1");

  const missing = await app.request(`/api/v1/sessions/${session.sessionId}/rewind`, post({ clientRequestId: "nope", restoreWork: true }));
  expect(missing.status).toBe(404);
  expect(await readFile(scriptPath(), "utf8")).toBe(WRONG_DRAFT);
}, 30000);
