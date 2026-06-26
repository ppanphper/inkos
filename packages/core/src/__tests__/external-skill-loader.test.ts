import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillRegistry,
  loadExternalCapabilitySkills,
} from "../skills/index.js";

describe("external skill loader", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-external-skills-"));
  });

  afterEach(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });

  it("loads a data-only SKILL.md manifest with body text", async () => {
    const skillDir = join(root, "detective-play");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "id: detective-play",
        "name: Detective Play",
        "description: Detective evidence and suspect-board play.",
        "whenToUse: Use for open-world detective play and evidence ledgers.",
        "triggers:",
        "  - 侦探",
        "  - evidence",
        "sessionKinds:",
        "  - play",
        "promptPacks:",
        "  - detective.play",
        "toolHints:",
        "  - play_step",
        "contextNeeds:",
        "  - id: evidence-ledger",
        "    purpose: Preserve suspect, clue, and evidence chain state.",
        "    sources:",
        "      - world/evidence.md",
        "    tier: protected",
        "    appliesTo:",
        "      - play_step",
        "    retrieval: semantic",
        "---",
        "",
        "Use evidence chains; do not turn clues into generic atmosphere.",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(join(skillDir, "scripts", "install.sh"), "echo should-not-run\n", "utf-8");

    const result = await loadExternalCapabilitySkills({ externalDirs: [skillDir] });

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      id: "detective-play",
      source: "external",
      promptPacks: ["detective.play"],
      body: expect.stringContaining("Use evidence chains"),
    });
    expect(result.skills[0].contextNeeds.map((need) => need.id)).toContain("evidence-ledger");
  });

  it("registers loaded external skills with the normal registry", async () => {
    const skillDir = join(root, "romance-play");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "id: romance-play",
        "name: Romance Play",
        "description: Romance interaction skill.",
        "whenToUse: Use for romance play.",
        "triggers: [恋爱]",
        "sessionKinds: [play]",
        "contextNeeds:",
        "  - id: relationship-tone",
        "    purpose: Preserve relationship tone.",
        "    sources: [world/relationships.md]",
        "    tier: protected",
        "    appliesTo: [play_step]",
        "    retrieval: semantic",
        "---",
        "Romance body.",
      ].join("\n"),
      "utf-8",
    );

    const loaded = await loadExternalCapabilitySkills({ externalDirs: [root] });
    const registry = createSkillRegistry({ skills: loaded.skills });
    const resolved = registry.resolveSkills({ requestedSkills: ["romance-play"] });

    expect(resolved.usedSkills.map((skill) => skill.id)).toEqual(["romance-play"]);
    expect(resolved.forcedSkillIds).toEqual(["romance-play"]);
  });

  it("rejects relative external directories", async () => {
    await expect(loadExternalCapabilitySkills({ externalDirs: [relative(process.cwd(), root)] }))
      .rejects.toThrow(/absolute/);
  });
});
