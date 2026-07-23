import { describe, expect, it } from "vitest";
import {
  RUNTIME_PCB_SKILLS,
  buildRuntimePcbSkillContext,
  selectRuntimePcbSkills,
} from "./runtimePcbSkills";

describe("runtime PCB skill routing", () => {
  it("keeps skill ids unique", () => {
    const ids = RUNTIME_PCB_SKILLS.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("selects only the strongest two procedures", () => {
    const selected = selectRuntimePcbSkills({
      prompt: "Find a stocked USB-C controller part and confirm its datasheet pinout and footprint",
      activeView: "schematic",
      componentTags: ["connector"],
    });
    expect(selected).toHaveLength(2);
    expect(selected.map((skill) => skill.id)).toContain("datasheet-evidence");
    expect(selected.map((skill) => skill.id)).toContain("component-selection");
  });

  it("adapts to PCB placement work", () => {
    const [selected] = selectRuntimePcbSkills({
      prompt: "Move and rotate these parts for a cleaner PCB layout",
      activeView: "pcb",
    });
    expect(selected.id).toBe("pcb-layout");
  });

  it("falls back to tscircuit authoring for a generic edit", () => {
    const selected = selectRuntimePcbSkills({
      prompt: "Update this design",
      activeView: "schematic",
    });
    expect(selected.map((skill) => skill.id)).toContain("tscircuit-authoring");
  });

  it("returns no injected procedure for unrelated conversation", () => {
    expect(
      selectRuntimePcbSkills({
        prompt: "hello there",
        activeView: "schematic",
      })
    ).toEqual([]);
  });

  it("renders selected guidance without dumping the full catalog", () => {
    const context = buildRuntimePcbSkillContext({
      prompt: "Fix the invalid short and unconnected pin",
      activeView: "schematic",
    });
    expect(context).toContain("### validation repair");
    expect(context).toContain("Apply:");
    expect(context).toContain("Verify:");
    expect(context).not.toContain("### analog signal chain");
  });

  it("never exposes more than two skills even when a larger limit is requested", () => {
    const selected = selectRuntimePcbSkills(
      {
        prompt: "Design and fix a USB battery power PCB, verify parts, pins, datasheets, and DRC",
        activeView: "pcb",
      },
      99
    );
    expect(selected.length).toBeLessThanOrEqual(2);
  });
});
