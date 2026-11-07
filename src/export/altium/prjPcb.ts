import type { Project } from "../../model/types"

// The `.PrjPcb`: an INI file that lists the project's documents, its settings and its parameters. Net identifier scope is Altium's Automatic, which
// for a project with sheet symbols is hierarchical (ports join sheet entries, net labels stay on their sheet, power ports are global) and is how the
// editor joins a project's nets: hierarchical labels are ports, local labels net labels, global labels and supplies power ports.

const clean = (v: string) => v.replace(/[\r\n]+/g, " ")

/** The project file listing `schDocs` (the root first) and the board. */
export function prjPcbText(project: Project, schDocs: string[], pcbDoc: string): string {
  const lines: string[] = [
    "[Design]",
    "Version=1.0",
    "HierarchyMode=0",
    "ChannelRoomNamingStyle=0",
    "ChannelDesignatorFormatString=$Component_$RoomName",
    "ChannelRoomLevelSeperator=_",
    "OpenOutputs=1",
    "ArchiveProject=0",
    "TimestampOutput=0",
    "SeparateFolders=0",
    "PinSwapBy_Netlabel=1",
    "PinSwapBy_Pin=1",
    "AllowPortNetNames=0",
    "AllowSheetEntryNetNames=1",
    "AppendSheetNumberToLocalNets=0",
    "NetlistSinglePinNets=0",
    "DefaultConfiguration=Default Configuration",
    "UserID=0xFFFFFFFF",
    "DefaultPcbProtel=1",
    "DefaultPcbPcad=0",
    "ReorderDocumentsOnCompile=1",
    "NameNetsHierarchically=0",
    "PowerPortNamesTakePriority=0",
    "PushECOToAnnotationFile=1",
    "",
  ]
  const docs = [...schDocs, pcbDoc]
  docs.forEach((path, i) => {
    lines.push(
      `[Document${i + 1}]`,
      `DocumentPath=${path}`,
      "AnnotationEnabled=1",
      "AnnotateStartValue=1",
      "AnnotationIndexControlEnabled=0",
      "AnnotateSuffix=",
      "AnnotateScope=All",
      `AnnotateOrder=${path === pcbDoc ? -1 : i}`,
      "DoLibraryUpdate=1",
      "DoDatabaseUpdate=1",
      "ClassGenCCAutoEnabled=1",
      "ClassGenCCAutoRoomEnabled=1",
      "ClassGenNCAutoScope=None",
      "DItemRevisionGUID=",
      "GenerateClassCluster=0",
      "",
    )
  })
  // The project's name, description and properties as project parameters, which a sheet's title block and any special string can show.
  const params: { key: string; value: string }[] = [{ key: "ProjectName", value: project.name }, ...(project.description ? [{ key: "Description", value: project.description }] : []), ...(project.properties ?? [])]
  const seen = new Set<string>()
  let n = 0
  for (const p of params) {
    const key = clean(p.key).replace(/[=[\]]/g, "_")
    if (!key || seen.has(key.toLowerCase())) continue
    seen.add(key.toLowerCase())
    n++
    lines.push(`[Parameter${n}]`, `Name=${key}`, `Value=${clean(p.value)}`, "")
  }
  lines.push("[Configuration1]", "Name=Default Configuration", "ParameterCount=0", "ConstraintFileCount=0", "ReleaseItemId=", "Variant=[No Variations]", "OutputJobsCount=0", "")
  return lines.join("\r\n")
}
