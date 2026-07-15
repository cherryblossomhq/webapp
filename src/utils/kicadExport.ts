import JSZip from "jszip";
import type { AnyCircuitElement } from "circuit-json";
import {
  CircuitJsonToKicadSchConverter,
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
} from "circuit-json-to-kicad";

/**
 * Convert the evaluated circuit JSON into a KiCad project and bundle the
 * schematic (`.kicad_sch`), PCB (`.kicad_pcb`), and project (`.kicad_pro`)
 * files into a single zip. KiCad expects these three files to live side by
 * side and share a base name, so they're nested under a `<projectName>/`
 * folder that unzips straight into a ready-to-open project directory.
 */
export async function buildKicadProjectZip(
  circuitJson: AnyCircuitElement[],
  projectName: string
): Promise<Blob> {
  const schFilename = `${projectName}.kicad_sch`;
  const pcbFilename = `${projectName}.kicad_pcb`;
  const proFilename = `${projectName}.kicad_pro`;

  const sch = new CircuitJsonToKicadSchConverter(circuitJson);
  sch.runUntilFinished();

  const pcb = new CircuitJsonToKicadPcbConverter(circuitJson, { projectName });
  pcb.runUntilFinished();

  const pro = new CircuitJsonToKicadProConverter(circuitJson, {
    projectName,
    schematicFilename: schFilename,
    pcbFilename: pcbFilename,
  });
  pro.runUntilFinished();

  const zip = new JSZip();
  const folder = zip.folder(projectName) ?? zip;
  folder.file(schFilename, sch.getOutputString());
  folder.file(pcbFilename, pcb.getOutputString());
  folder.file(proFilename, pro.getOutputString());

  return zip.generateAsync({ type: "blob" });
}
