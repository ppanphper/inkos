import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlayStartTool,
  createPlayStepTool,
} from "../agent/agent-tools.js";
import { PlayStore } from "../play/play-store.js";
import type { PlayStepResult } from "../play/play-runner.js";

describe("agent play tools", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-agent-play-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts a play world from chat input and persists the opening scene", async () => {
    const tool = createPlayStartTool(root);
    const result = await tool.execute("tc-start", {
      worldId: "rain-teahouse",
      runId: "main",
      title: "雨夜茶馆",
      premise: "玩家扮演欠债茶馆老板，雨夜有人带着账本上门。",
      mode: "open",
      initialScene: "雨一直下，柜台上的账本被敲了三下。",
      suggestedActions: ["查看账本", "问来人是谁"],
    });

    expect(result.details).toMatchObject({
      kind: "play_world_started",
      worldId: "rain-teahouse",
      runId: "main",
      title: "雨夜茶馆",
      sceneText: "雨一直下，柜台上的账本被敲了三下。",
    });

    const store = new PlayStore(root);
    await expect(store.loadWorld("rain-teahouse")).resolves.toMatchObject({
      title: "雨夜茶馆",
      mode: "open",
    });
    await expect(store.readTranscript("rain-teahouse", "main")).resolves.toMatchObject([
      { role: "assistant", content: "雨一直下，柜台上的账本被敲了三下。" },
    ]);
    await expect(store.readProjection("rain-teahouse", "main", "projections/scene.md"))
      .resolves.toContain("雨一直下");
  });

  it("advances the most recent play world when the agent omits ids", async () => {
    const store = new PlayStore(root);
    await store.createWorld({
      id: "rain-teahouse",
      title: "雨夜茶馆",
      premise: "玩家扮演茶馆老板。",
      mode: "open",
    });
    await store.ensureRun("rain-teahouse", "main");
    await store.writeProjection("rain-teahouse", "main", "projections/scene.md", "柜台上有一本潮湿账本。\n");

    const step: PlayStepResult = {
      sceneText: "你翻开账本，发现最后一页夹着一张旧船票。",
      suggestedActions: ["藏起船票", "追问送账本的人"],
      action: {
        actionKind: "look",
        intent: "查看账本",
        manner: "",
        risk: "",
        ambiguity: "",
        secondaryActions: [],
      },
      mutation: {
        eventId: "evt-1",
        turn: 1,
        actionKind: "look",
        summary: "玩家发现旧船票。",
        entities: { upsert: [] },
        edges: { upsert: [], expire: [] },
        stateSlots: { upsert: [] },
        evidence: { transitions: [] },
        blocked: false,
        blockedReason: "",
        notes: [],
      },
    };
    const runnerFactory = vi.fn(() => ({ step: vi.fn(async () => step) }));
    const tool = createPlayStepTool(
      { createAgentContext: vi.fn(() => ({})) } as any,
      root,
      { runnerFactory },
    );

    const result = await tool.execute("tc-step", {
      input: "我翻开账本看最后一页",
    });

    expect(runnerFactory).toHaveBeenCalledWith(expect.objectContaining({
      worldId: "rain-teahouse",
      runId: "main",
    }));
    expect(result.details).toMatchObject({
      kind: "play_turn_advanced",
      worldId: "rain-teahouse",
      runId: "main",
      sceneText: "你翻开账本，发现最后一页夹着一张旧船票。",
    });
  });
});
