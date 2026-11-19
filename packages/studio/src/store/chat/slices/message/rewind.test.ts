import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ChatStore, Message, RewindPlan } from "../../types";
import { initialChatState } from "../../initialState";
import { createCreateSlice } from "../create/action";
import { createMessageSlice } from "./action";
import { closeStudioEventConnections } from "../../../../lib/studio-events";
import { editableMessageText, rewindNeedsConfirmation, rewindTargetForMessage } from "../../rewind";

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("../../../../hooks/use-api", () => ({ fetchJson }));

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  constructor(readonly url: string) { fakeEventSources.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() { this.closed = true; }
}
const fakeEventSources: FakeEventSource[] = [];

function createTestStore() {
  return createStore<ChatStore>()((...args) => ({
    ...initialChatState,
    ...createMessageSlice(...args),
    ...createCreateSlice(...args),
  }));
}

function seedMessages(store: ReturnType<typeof createTestStore>, messages: Message[]): string {
  const sessionId = store.getState().createDraftSession(null, "chat");
  store.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, isDraft: false, messages } },
  }));
  return sessionId;
}

const plan = (overrides: Partial<RewindPlan> = {}): RewindPlan => ({
  sessionId: "s", targetRequestId: "r1", requestIds: ["r1"], turnCount: 1, work: { status: "unchanged", workId: "w" }, ...overrides,
});

describe("message rewind", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    fetchJson.mockReset();
    fetchJson.mockResolvedValue({});
    fakeEventSources.length = 0;
    (globalThis as any).EventSource = FakeEventSource;
  });

  afterEach(() => {
    closeStudioEventConnections();
    (globalThis as any).EventSource = originalEventSource;
  });

  it("marks a stopped turn's message as outside the conversation and keeps its request identity", async () => {
    const store = createTestStore();
    const sessionId = store.getState().createDraftSession(null, "chat");
    store.getState().setSelectedModel("fixture", "custom");
    let rejectAgent!: (error: Error) => void;
    fetchJson
      .mockResolvedValueOnce({ session: { sessionId, bookId: null, sessionKind: "chat" } })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAgent = reject; }))
      .mockResolvedValueOnce({});

    const sent = store.getState().sendMessage(sessionId, "写错的指令");
    await vi.waitFor(() => expect(fakeEventSources).toHaveLength(1));
    const agentBody = JSON.parse(fetchJson.mock.calls[1]![1].body);
    await store.getState().abortSession(sessionId);
    rejectAgent(new Error("This operation was aborted"));
    await sent;

    const user = store.getState().sessions[sessionId]!.messages.find((message) => message.role === "user");
    expect(user).toMatchObject({ content: "写错的指令", clientRequestId: agentBody.clientRequestId, requestStatus: "failed" });
  });

  it("puts a message's own text into the composer for editing", () => {
    const store = createTestStore();
    const sessionId = seedMessages(store, [
      { role: "user", content: "改第二章\n\n附件：\n- notes.md", timestamp: 1, requestId: "r1", requestStatus: "committed" },
      { role: "assistant", content: "好的", timestamp: 2 },
    ]);

    store.getState().beginEditMessage(sessionId, 0);

    expect(store.getState().input).toBe("改第二章");
    expect(store.getState().editingMessage).toEqual({ sessionId, messageIndex: 0, target: { requestId: "r1" } });
    store.getState().cancelEditMessage();
    expect(store.getState()).toMatchObject({ input: "", editingMessage: null });
  });

  it("replaces the conversation with the server's result and refreshes work data after restoring files", async () => {
    const store = createTestStore();
    const sessionId = seedMessages(store, [
      { role: "user", content: "第一条", timestamp: 1, requestId: "r1", requestStatus: "committed" },
      { role: "user", content: "写错的", timestamp: 2, requestId: "r2", requestStatus: "committed" },
    ]);
    store.getState().beginEditMessage(sessionId, 1);
    const version = store.getState().bookDataVersion;
    fetchJson.mockResolvedValueOnce({
      result: { ...plan({ targetRequestId: "r2", requestIds: ["r2"] }), workRestored: true },
      session: { sessionId, messages: [{ role: "user", content: "第一条", timestamp: 1, requestId: "r1", requestStatus: "committed" }] },
    });

    await store.getState().rewindSession(sessionId, { requestId: "r2" }, { restoreWork: true, expectedRequestIds: ["r2"] });

    expect(fetchJson).toHaveBeenCalledWith(`/sessions/${sessionId}/rewind`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ requestId: "r2", restoreWork: true, expectedRequestIds: ["r2"] }),
    }));
    expect(store.getState().sessions[sessionId]!.messages.map((message) => message.content)).toEqual(["第一条"]);
    expect(store.getState().bookDataVersion).toBe(version + 1);
  });

  it("waits for a just-stopped turn to settle before rewinding", async () => {
    const store = createTestStore();
    const sessionId = seedMessages(store, [{ role: "user", content: "停了", timestamp: 1, clientRequestId: "c1", requestStatus: "failed" }]);
    fetchJson
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 409, payload: { error: { code: "SESSION_BUSY" } } }))
      .mockResolvedValueOnce({ result: { ...plan(), workRestored: false }, session: { sessionId, messages: [] } });

    await store.getState().rewindSession(sessionId, { clientRequestId: "c1" }, { restoreWork: false, retryDelayMs: 1 });

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(store.getState().sessions[sessionId]!.messages).toEqual([]);
  });

  it("drops a stopped message locally when the server never recorded it", async () => {
    const store = createTestStore();
    const sessionId = seedMessages(store, [
      { role: "user", content: "早停", timestamp: 1, clientRequestId: "c1", requestStatus: "failed" },
      { role: "assistant", kind: "error", content: "已由用户停止", timestamp: 2 },
    ]);
    fetchJson.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404, payload: { error: { code: "REWIND_TARGET_NOT_FOUND" } } }));

    await store.getState().rewindSession(sessionId, { clientRequestId: "c1" }, { restoreWork: false });

    expect(store.getState().sessions[sessionId]!.messages).toEqual([]);
  });

  it("keeps the conversation and reports the reason when the rewind is refused", async () => {
    const store = createTestStore();
    const messages: Message[] = [{ role: "user", content: "已完成", timestamp: 1, requestId: "r1", requestStatus: "committed" }];
    const sessionId = seedMessages(store, messages);
    fetchJson.mockRejectedValueOnce(Object.assign(new Error("作品文件无法回退"), { status: 409, payload: { error: { code: "REWIND_WORK_UNAVAILABLE" } } }));

    await expect(store.getState().rewindSession(sessionId, { requestId: "r1" }, { restoreWork: true }))
      .rejects.toThrow("作品文件无法回退");
    expect(store.getState().sessions[sessionId]!.messages).toEqual(messages);
  });
});

describe("rewind helpers", () => {
  it("targets transcript requests first and optimistic sends by their client id", () => {
    expect(rewindTargetForMessage({ role: "user", content: "a", timestamp: 1, requestId: "r1", clientRequestId: "c1" })).toEqual({ requestId: "r1" });
    expect(rewindTargetForMessage({ role: "user", content: "a", timestamp: 1, clientRequestId: "c1" })).toEqual({ clientRequestId: "c1" });
    expect(rewindTargetForMessage({ role: "user", content: "a", timestamp: 1 })).toBeNull();
    expect(rewindTargetForMessage({ role: "assistant", content: "a", timestamp: 1, requestId: "r1" })).toBeNull();
  });

  it("prefers the exact typed text over the displayed attachment summary", () => {
    expect(editableMessageText({ role: "user", content: "看看\n\nAttachments:\n- a.png (image/png, 3 KB)", timestamp: 1 })).toBe("看看");
    expect(editableMessageText({ role: "user", content: "显示文本", editText: "原文", timestamp: 1 })).toBe("原文");
  });

  it("asks before rewinding several turns, any file change, or a completed turn being retracted", () => {
    expect(rewindNeedsConfirmation(plan(), "edit")).toBe(false);
    expect(rewindNeedsConfirmation(plan({ turnCount: 2 }), "edit")).toBe(true);
    expect(rewindNeedsConfirmation(plan({ work: { status: "available", workId: "w", changes: [{ path: "a.md", action: "restore" }] } }), "edit")).toBe(true);
    expect(rewindNeedsConfirmation(plan({ work: { status: "unavailable", workId: "w", reason: "EXTERNAL_CHANGE", paths: [] } }), "edit")).toBe(true);
    expect(rewindNeedsConfirmation(plan(), "retract", "committed")).toBe(true);
    expect(rewindNeedsConfirmation(plan(), "retract", "failed")).toBe(false);
  });
});
