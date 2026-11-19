import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { TranscriptEventSchema, type TranscriptEvent } from "./session-transcript-schema.js";
import type { SessionKind, TranscriptRole, WorkCheckpointRef } from "./session-transcript-schema.js";
import { captureWorkCheckpoint } from "./work-checkpoint.js";

const SESSIONS_DIR = ".inkos/sessions";
const appendQueues = new Map<string, Promise<void>>();

/** Requests retracted by a later `requests_rewound` event. */
export function rewoundRequestIds(events: ReadonlyArray<TranscriptEvent>): Set<string> {
  return new Set(events.flatMap((event) => event.type === "requests_rewound" ? event.requestIds : []));
}

/** The Work a session currently targets, from its creation and metadata events. */
export function sessionWorkIdFromEvents(events: ReadonlyArray<TranscriptEvent>): string | null {
  let workId: string | null | undefined;
  let bookId: string | null = null;
  for (const event of events) {
    if (event.type !== "session_created" && event.type !== "session_metadata_updated") continue;
    if (event.workId !== undefined) workId = event.workId;
    if (event.bookId !== undefined) bookId = event.bookId;
  }
  return workId === undefined ? bookId : workId;
}

/** Recover the request that produced this confirmation, even after other chat turns. */
export function confirmedRequestInstruction(
  events: ReadonlyArray<TranscriptEvent>, action: string, instruction: string,
): string {
  const rewound = rewoundRequestIds(events);
  for (const event of [...events].reverse()) {
    if (event.type !== "message" || event.role !== "toolResult" || rewound.has(event.requestId)) continue;
    const details = (event.message as { details?: Record<string, unknown> }).details;
    if (details?.kind !== "proposed_action" || details.action !== action || details.instruction !== instruction) continue;
    const request = events.find(candidate => candidate.type === "request_started" && candidate.requestId === event.requestId);
    if (request?.type === "request_started" && request.input.trim()) return request.input;
  }
  return instruction;
}

export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, SESSIONS_DIR);
}

export function transcriptPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.jsonl`);
}

export async function readTranscriptEvents(
  projectRoot: string,
  sessionId: string,
): Promise<TranscriptEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(projectRoot, sessionId), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const events: TranscriptEvent[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(TranscriptEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new Error(`Invalid transcript event at ${transcriptPath(projectRoot, sessionId)}:${index + 1}: ${String(error)}`);
    }
  }

  return events.sort((a, b) => a.seq - b.seq);
}

export async function nextTranscriptSeq(projectRoot: string, sessionId: string): Promise<number> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  return events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

export async function appendTranscriptEvent(
  projectRoot: string,
  event: TranscriptEvent,
): Promise<void> {
  await appendTranscriptEvents(projectRoot, event.sessionId, () => [event]);
}

export async function appendTranscriptEvents(
  projectRoot: string,
  sessionId: string,
  buildEvents: (context: {
    readonly events: ReadonlyArray<TranscriptEvent>;
    readonly nextSeq: number;
  }) => ReadonlyArray<TranscriptEvent> | Promise<ReadonlyArray<TranscriptEvent>>,
): Promise<TranscriptEvent[]> {
  const key = `${projectRoot}:${sessionId}`;
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let result: TranscriptEvent[] = [];

  const next = previous.then(async () => {
    const events = await readTranscriptEvents(projectRoot, sessionId);
    const nextSeq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
    const built = await buildEvents({ events, nextSeq });
    result = built.map((event) => TranscriptEventSchema.parse(event));
    if (result.length === 0) return;

    await mkdir(sessionsDir(projectRoot), { recursive: true });
    await appendFile(
      transcriptPath(projectRoot, sessionId),
      `${result.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
  });

  appendQueues.set(key, next.catch(() => undefined));
  await next;
  return result;
}

function transcriptRoleForMessage(message: AgentMessage): TranscriptRole | null {
  if (!message || typeof message !== "object" || !("role" in message)) return null;
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system"
    ? role
    : null;
}

function messageTimestamp(message: AgentMessage): number {
  if (message && typeof message === "object") {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
      return Math.floor(timestamp);
    }
  }
  return Date.now();
}

function toolCallIdForMessage(message: AgentMessage): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role === "toolResult") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find(
    (item): item is { type: "toolCall"; id: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { id?: unknown }).id === "string",
  );
  return block?.id;
}

export async function appendManualSessionMessages(
  projectRoot: string,
  sessionId: string,
  messages: ReadonlyArray<AgentMessage>,
  input = "",
  options: {
    readonly sessionKind?: SessionKind;
    readonly clientRequestId?: string;
    /** Work state before the recorded work began, e.g. at a production task's start. */
    readonly startWorkCheckpoint?: WorkCheckpointRef;
    readonly display?: {
      readonly thinking?: string;
      readonly toolExecutions?: readonly unknown[];
    };
  } = {},
): Promise<void> {
  const persistedMessages = messages
    .map((message) => ({ message, role: transcriptRoleForMessage(message) }))
    .filter((entry): entry is { message: AgentMessage; role: TranscriptRole } => entry.role !== null);
  if (persistedMessages.length === 0) return;

  const requestId = randomUUID();
  const workId = sessionWorkIdFromEvents(await readTranscriptEvents(projectRoot, sessionId));
  const endWorkCheckpoint = workId ? await captureWorkCheckpoint(projectRoot, workId).catch(() => undefined) : undefined;
  const startWorkCheckpoint = options.startWorkCheckpoint ?? endWorkCheckpoint;
  await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => {
    let seq = nextSeq;
    const events: TranscriptEvent[] = [{
      type: "request_started",
      version: 1,
      sessionId,
      requestId,
      seq: seq++,
      timestamp: Date.now(),
      ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
      input,
      ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
      ...(startWorkCheckpoint ? { workCheckpoint: startWorkCheckpoint } : {}),
    }];

    let parentUuid: string | null = null;
    let lastAssistantUuid: string | null = null;
    for (const { message, role } of persistedMessages) {
      const uuid = randomUUID();
      const isToolResult = role === "toolResult";
      const toolCallId = toolCallIdForMessage(message);
      const display = role === "assistant" && options.display
        ? {
            ...(options.display.thinking ? { thinking: options.display.thinking } : {}),
            ...(options.display.toolExecutions?.length
              ? { toolExecutions: [...options.display.toolExecutions] }
              : {}),
          }
        : undefined;
      events.push({
        type: "message",
        version: 1,
        sessionId,
        requestId,
        uuid,
        parentUuid: isToolResult && lastAssistantUuid ? lastAssistantUuid : parentUuid,
        seq: seq++,
        role,
        timestamp: messageTimestamp(message),
        ...(toolCallId ? { toolCallId } : {}),
        ...(isToolResult && lastAssistantUuid
          ? { sourceToolAssistantUuid: lastAssistantUuid }
          : {}),
        ...(display && (display.thinking || display.toolExecutions?.length)
          ? { display }
          : {}),
        message,
      });
      if (role === "assistant") lastAssistantUuid = uuid;
      parentUuid = uuid;
    }

    events.push({
      type: "request_committed",
      version: 1,
      sessionId,
      requestId,
      seq,
      timestamp: Date.now(),
      ...(endWorkCheckpoint ? { workCheckpoint: endWorkCheckpoint } : {}),
    });
    return events;
  });
}
