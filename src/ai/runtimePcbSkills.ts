import type { ActiveView } from "../utils/chatSystemPrompt";

export interface RuntimePcbSkill {
  id: string;
  title: string;
  purpose: string;
  keywords: readonly string[];
  views?: readonly ActiveView[];
  componentTags?: readonly string[];
  instructions: readonly string[];
  verify: readonly string[];
}

export interface RuntimeSkillInput {
  prompt: string;
  activeView: ActiveView;
  componentTags?: readonly string[];
}

/**
 * Small, versioned-in-code capability modules. The router exposes at most two
 * per turn so the model gets relevant domain procedure without a giant static
 * prompt or a user-facing skill picker.
 */
export const RUNTIME_PCB_SKILLS: readonly RuntimePcbSkill[] = [
  {
    id: "tscircuit-authoring",
    title: "tscircuit authoring",
    purpose: "Create or structurally edit a circuit with valid tscircuit primitives.",
    keywords: [
      "add",
      "build",
      "create",
      "design",
      "change",
      "replace",
      "remove",
      "circuit",
      "schematic",
    ],
    views: ["schematic", "code"],
    instructions: [
      "Keep the circuit as a default export returning one board and use documented built-in element props.",
      "For arbitrary devices use chip with pinLabels and pinAttributes defined before any connection references; use connector standard=usb_c for USB-C.",
      "Prefer semantic circuit tools, stable designators, and named nets. Never disturb existing stable keys or physical placement unless requested.",
      "Establish components and connectivity first, then placement, then validation.",
    ],
    verify: [
      "Every referenced component and pin exists.",
      "The resulting TSX parses and has one default board export.",
    ],
  },
  {
    id: "component-selection",
    title: "component selection",
    purpose: "Choose a real, orderable part that satisfies electrical constraints.",
    keywords: [
      "part",
      "component",
      "choose",
      "select",
      "find",
      "jlcpcb",
      "lcsc",
      "stock",
      "bom",
      "substitute",
      "alternative",
    ],
    views: ["bom", "schematic"],
    instructions: [
      "Extract voltage, current, package, interface, temperature, stock, and cost constraints before choosing.",
      "Use built-in passives and common discrete semiconductors; search and import non-trivial ICs only.",
      "Prefer JLCPCB Basic parts when equivalent, and record the exact LCSC identity and footprint family.",
    ],
    verify: [
      "The selected part meets every hard electrical constraint.",
      "Package, footprint, pinout, and orderable identity agree.",
    ],
  },
  {
    id: "datasheet-evidence",
    title: "datasheet evidence",
    purpose: "Ground critical part decisions in the manufacturer's limits and pin definitions.",
    keywords: [
      "datasheet",
      "maximum",
      "rating",
      "voltage",
      "current",
      "pinout",
      "pin",
      "footprint",
      "package",
      "verify",
      "confirm",
    ],
    instructions: [
      "Fetch the datasheet before placing an unfamiliar IC or making a critical limit claim.",
      "Separate recommended operating conditions from absolute maximum ratings and retain page/section evidence when available.",
      "Map physical pin numbers to logical labels before connectivity work.",
    ],
    verify: [
      "Input rails, load current, topology, and required external components are supported.",
      "Pin labels and footprint match the chosen orderable package.",
    ],
  },
  {
    id: "power-integrity",
    title: "power integrity",
    purpose: "Design power entry, conversion, decoupling, and protection coherently.",
    keywords: [
      "power",
      "battery",
      "supply",
      "regulator",
      "ldo",
      "buck",
      "boost",
      "charger",
      "decoupling",
      "bypass",
      "ground",
      "vcc",
      "3v3",
      "5v",
    ],
    componentTags: ["battery", "fuse"],
    instructions: [
      "Name every rail and trace the full power path from source through protection and conversion to each load.",
      "Place required input, output, and local decoupling capacitors according to the verified device guidance.",
      "Keep voltage domains explicit; never short rails or treat absolute maximum ratings as operating targets.",
    ],
    verify: [
      "Every IC power and ground pin has an intentional connection.",
      "Rail voltage and current budgets cover startup and worst-case load.",
    ],
  },
  {
    id: "digital-interfaces",
    title: "digital interfaces",
    purpose: "Wire buses and connectors with complete support circuitry.",
    keywords: [
      "usb",
      "usb-c",
      "i2c",
      "spi",
      "uart",
      "can",
      "mcu",
      "microcontroller",
      "connector",
      "sda",
      "scl",
      "tx",
      "rx",
    ],
    componentTags: ["connector", "pinheader", "chip"],
    instructions: [
      "Use the interface's canonical signal names and keep differential or bus pairs complete.",
      "Include required pull-ups, configuration resistors, termination, ESD protection, and exposed power/ground returns.",
      "For USB-C use the built-in connector and handle CC pins according to the intended host/device role.",
    ],
    verify: [
      "No bus endpoint, return, enable, or configuration pin is floating unintentionally.",
      "Signal voltage domains are compatible at both endpoints.",
    ],
  },
  {
    id: "analog-signal-chain",
    title: "analog signal chain",
    purpose: "Preserve range, bias, filtering, and reference integrity through analog paths.",
    keywords: [
      "analog",
      "opamp",
      "op-amp",
      "adc",
      "dac",
      "sensor",
      "filter",
      "amplifier",
      "gain",
      "reference",
      "feedback",
    ],
    componentTags: ["opamp", "potentiometer"],
    instructions: [
      "Work from source range and impedance through gain/filter stages to the receiving input range.",
      "Check common-mode range, output swing, bandwidth, stability, bias paths, and reference return.",
      "Keep high-impedance nodes and feedback loops explicit and short in the later PCB placement phase.",
    ],
    verify: [
      "Nominal and worst-case signals remain inside every stage's valid range.",
      "Inputs have defined DC bias and no required feedback path is open.",
    ],
  },
  {
    id: "pcb-layout",
    title: "PCB layout",
    purpose: "Translate a correct netlist into deliberate placement and routing constraints.",
    keywords: [
      "pcb",
      "layout",
      "place",
      "placement",
      "move",
      "rotate",
      "route",
      "routing",
      "layer",
      "via",
      "clearance",
      "drc",
    ],
    views: ["pcb", "cad"],
    instructions: [
      "Treat existing manual placement and routes as user-owned; change only the physical scope requested.",
      "Place connectors and mechanical constraints first, then power/current loops, decoupling, sensitive analog, and ordinary signals.",
      "Keep connectivity as the source of truth and use DRC as a secondary validation signal after the intended netlist is complete.",
    ],
    verify: [
      "No component lies outside the board and no deliberate user placement was lost.",
      "Critical current loops, returns, differential pairs, and clearances are plausible.",
    ],
  },
  {
    id: "validation-repair",
    title: "validation repair",
    purpose: "Diagnose an invalid candidate and make the smallest grounded repair.",
    keywords: [
      "error",
      "issue",
      "broken",
      "invalid",
      "fix",
      "repair",
      "debug",
      "drc",
      "unconnected",
      "short",
    ],
    instructions: [
      "Classify the failure as syntax, missing part/pin, connectivity, electrical constraint, footprint, or placement before editing.",
      "Repair the smallest responsible concept and preserve all unrelated keys, coordinates, and connections.",
      "Resolve component and pin semantics before attempting physical placement fixes.",
    ],
    verify: [
      "The reported failure is gone and no new error was introduced.",
      "The repair did not broaden beyond the failed concept.",
    ],
  },
];

const EDIT_INTENT = /\b(add|build|create|design|change|replace|remove|connect|wire|fix|repair|move|route|update)\b/i;

function skillScore(skill: RuntimePcbSkill, input: RuntimeSkillInput): number {
  const prompt = input.prompt.toLowerCase();
  const keywordHits = skill.keywords.filter((keyword) =>
    prompt.includes(keyword.toLowerCase())
  ).length;
  if (keywordHits === 0) {
    if (skill.id === "tscircuit-authoring" && EDIT_INTENT.test(input.prompt)) return 2;
    return 0;
  }
  let score = Math.min(keywordHits, 4) * 3;
  if (skill.views?.includes(input.activeView)) score += 1;
  const tags = new Set((input.componentTags ?? []).map((tag) => tag.toLowerCase()));
  if (skill.componentTags?.some((tag) => tags.has(tag.toLowerCase()))) score += 2;
  return score;
}

export function selectRuntimePcbSkills(
  input: RuntimeSkillInput,
  limit = 2
): RuntimePcbSkill[] {
  const boundedLimit = Math.max(0, Math.min(2, Math.floor(limit)));
  return RUNTIME_PCB_SKILLS.map((skill, index) => ({
    skill,
    index,
    score: skillScore(skill, input),
  }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, boundedLimit)
    .map((candidate) => candidate.skill);
}

export function buildRuntimePcbSkillContext(input: RuntimeSkillInput): string {
  const selected = selectRuntimePcbSkills(input);
  if (selected.length === 0) return "";
  const sections = selected.map((skill) => {
    const instructions = skill.instructions.map((item) => `- ${item}`).join("\n");
    const verify = skill.verify.map((item) => `- ${item}`).join("\n");
    return `### ${skill.title}\n${skill.purpose}\n\nApply:\n${instructions}\n\nVerify:\n${verify}`;
  });
  return `## Adapted PCB Guidance\n\nThe runtime selected only the procedures relevant to this turn.\n\n${sections.join("\n\n")}`;
}
