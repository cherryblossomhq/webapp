// What the importer does with every node and value atom of a KiCad schematic (`.kicad_sch`, KiCad 6
// and later), and with each line type of a KiCad 5 `.sch`. The same idea as `decisions.mjs`: a rule
// matches a node's whole path from the root, the first match wins, and a path, atom or keyword the
// census sees that no rule covers fails the run (`gap-table-sch.mjs`).
//
// What the editor holds today (`src/model/types.ts`): ONE flat sheet. A `ComponentInstance` is a
// part with a position and a quarter turn; a `Wire` is a polyline; a `NetLabel` is a name at a
// point. There are no sheets, buses, global or hierarchical labels, text, drawings, images, tables,
// units of a symbol, body styles, pin alternates, mirrored symbols, fields with their own place,
// or the in-BOM, on-board and do-not-populate flags. A part's symbol is one drawing of paths,
// circles and text on a 0.1 grid. Those are the S1 to S10 extensions of the doc.

const rule = (path, decision, today, extra = {}) => ({ path: new RegExp(`^(${path})$`), decision, today, ...extra })
const STYLE = "(?:stroke|stroke>(?:color|type|width)|fill|fill>(?:color|type))"
const TEXT = "(?:effects|effects>(?:justify|href|hide)|effects>font|effects>font>(?:size|thickness|bold|italic|face|color))"

export const RULES_SCH = [
  // ---- what only says how KiCad lays out and names its own files: read past, not kept (the export makes its own) ----
  rule("(?:symbol|label|global_label|hierarchical_label|netclass_flag|sheet)>fields_autoplaced|(?:.*>)?property>do_not_autoplace|(?:.*>)?effects>href", "not-needed", "-", { note: "KiCad's autoplacing flags and a text's hyperlink" }),
  rule("(?:label|global_label|hierarchical_label|netclass_flag)>uuid|sheet>(?:uuid|pin>uuid)|rule_area>polyline>uuid", "not-needed", "-", { note: "KiCad's object identity" }),
  rule("sheet>property>.+|sheet>instances>project>path>page|sheet_instances>path>page", "not-needed", "-", { note: "where a sheet's name and file are written on its box, and page numbers: the export lays them out and numbers the pages in the order of the tree" }),
  rule("text>exclude_from_sim|text_box>exclude_from_sim|table>cells>table_cell>exclude_from_sim", "not-needed", "-", { note: "a text left out of a simulation" }),

  // ---- the file ----
  rule("version|generator|generator_version", "native", "-", { effort: "S", note: "the reader's switches (KiCad 6 keeps instances in a root symbol_instances list, 7 and later inside each symbol)" }),
  rule("uuid", "native", "-", { effort: "S", note: "the sheet's id, the first part of every instance path" }),
  rule("paper", "not-needed", "-", { note: "sheet size of KiCad's drawing frame" }),
  rule("title_block(?:>.*)?", "native", "Project.properties", { effort: "S" }),
  rule("embedded_fonts", "extend", "-", { ext: "X19", note: "the fonts the schematic embeds" }),
  rule("embedded_files(?:>.*)?", "report", "-", { note: "founder decision: no files packed inside the KiCad file for now; each embedded datasheet or model is a report entry named per file" }),

  // ---- symbols in the library cache ----
  rule("lib_symbols", "native", "PartDef from kicad/convert.ts", { effort: "M", note: "each cached symbol becomes a project part (S10: today a project part cannot hold an arbitrary drawing)" }),
  rule("lib_symbols>symbol", "extend", "one SymbolDef per part", { ext: "S5", note: "units, body styles, power flag, inheritance (extends) resolved on read" }),
  rule("lib_symbols>symbol>(?:power|extends|embedded_fonts)", "native", "PartDef.powerNet", { effort: "S" }),
  rule("lib_symbols>symbol>duplicate_pin_numbers_are_jumpers", "extend", "PartDef.padAlias", { ext: "S5", note: "pins that share a number are one pin when this is yes; KiCad's default (no) says nothing" }),
  rule("lib_symbols>symbol>jumper_pin_groups(?:>.*)?", "extend", "PartDef.jumpers", { ext: "S5", note: "groups of pin numbers the symbol joins inside itself (KiCad 10)" }),
  rule("lib_symbols>symbol>(?:in_bom|on_board|exclude_from_sim|in_pos_files)", "extend", "-", { ext: "S7" }),
  rule("lib_symbols>symbol>body_styles", "extend", "-", { ext: "S5", note: "De Morgan and named body styles" }),
  rule("lib_symbols>symbol>(?:pin_names|pin_numbers)(?:>(?:hide|offset))?", "extend", "-", { ext: "S6", note: "whether pin names and numbers are drawn, and their offset" }),
  rule("lib_symbols>symbol>property(?:>.*)?", "extend", "PartDef.defaultProps", { ext: "S5", note: "field names are properties (native); each field's place, size, visibility and justification are per symbol and per instance" }),
  rule("lib_symbols>symbol>symbol(?:>unit_name)?", "extend", "-", { ext: "S5", note: "a unit of a multi-unit symbol and its body style" }),
  rule("lib_symbols>symbol>symbol>pin", "extend", "SymbolPort", { ext: "S5" }),
  rule("lib_symbols>symbol>symbol>pin>(?:at|length|hide|name|number|name>.*|number>.*|alternate|alternate>.*)", "extend", "SymbolPort, PinDef", { ext: "S5", note: "alternates, per-pin visibility, name and number text, any length and any of four directions" }),
  rule("lib_symbols>symbol>symbol>(?:arc|circle|polyline|rectangle|text|bezier|ellipse)(?:>.*)?", "extend", "SymbolPrimitive: path, circle, text", { ext: "S6", note: "arcs, beziers, ellipses, fills and stroke styles; the editor's drawing has paths, circles and text only" }),

  // ---- symbols on the sheet ----
  rule("symbol", "native", "ComponentInstance", { effort: "M" }),
  rule("symbol>(?:at|lib_id|lib_name|uuid)", "native", "ComponentInstance.sch, partId", { effort: "S", note: "a turn that is not a quarter turn does not occur in KiCad schematics" }),
  rule("symbol>(?:mirror|unit|body_style)", "extend", "-", { ext: "S5", note: "mirrored symbols, the unit of a multi-unit symbol, the body style" }),
  rule("symbol>(?:in_bom|on_board|dnp|exclude_from_sim|in_pos_files)", "extend", "-", { ext: "S7" }),
  rule("symbol>property(?:>.*)?", "extend", "ComponentInstance.props", { ext: "S5", note: "value is a property (native); place, size and visibility of each field are S5" }),
  rule("symbol>pin(?:>alternate)?", "extend", "-", { ext: "S5", note: "the alternate function chosen on this instance" }),
  rule("symbol>instances(?:>project(?:>path(?:>(?:reference|unit|value|footprint))?)?)?", "extend", "ComponentInstance.ref", { ext: "S1", note: "one reference per use of a sheet; the path names the sheet instance" }),
  rule("symbol>instances>project>path>variant(?:>.*)?", "extend", "-", { ext: "S9", note: "per-variant DNP and BOM flags and field overrides (KiCad 10)" }),
  rule("sheet>instances>project>path>variant(?:>.*)?", "extend", "-", { ext: "S9", note: "per-variant DNP and BOM flags and field overrides of a sheet (KiCad 10)" }),
  rule("symbol_instances(?:>path(?:>(?:reference|unit|value|footprint))?)?", "extend", "ComponentInstance.ref", { ext: "S1", note: "KiCad 6 keeps all instance data in one root list" }),

  // ---- wires, buses, junctions, flags ----
  rule("wire|wire>pts|wire>pts>xy", "native", "Wire", { effort: "S" }),
  rule(`wire>${STYLE}`, "extend", "Wire has no style", { ext: "S4", note: "wire width, dash style and colour" }),
  rule("symbol>pin>uuid|(?:wire|bus|junction|no_connect|bus_entry)>uuid", "not-needed", "-", { note: "KiCad's object identity" }),
  rule("junction|junction>at", "native", "wires cut at the junction: the editor joins wires at their ends", { effort: "S", note: "an explicit junction says two crossing wires are joined; the builder cuts the wires there" }),
  rule("junction>(?:diameter|color)", "extend", "-", { ext: "S4", note: "a junction dot of its own size or colour; KiCad's default (diameter 0, no colour) is what the editor draws" }),
  rule("no_connect|no_connect>at", "extend", "ComponentInstance.nc", { ext: "S4", note: "a no-connect flag on a pin is the pin's nc mark (carried); one that is not on a pin is a drawing of its own" }),
  rule("bus|bus>pts|bus>pts>xy|bus>stroke(?:>.*)?|bus_entry|bus_entry>(?:at|size|bus_to_bus|stroke(?:>.*)?)|bus_alias|bus_alias>members", "extend", "-", { ext: "S3", note: "buses, bus entries and bus aliases, with vector names like D[0..7]" }),

  // ---- labels ----
  rule("label|label>(?:at|fields_autoplaced|uuid)", "native", "NetLabel", { effort: "S", note: "a local label belongs to its sheet" }),
  rule(`label>${TEXT}`, "extend", "NetLabel has a name, a place and a quarter turn", { ext: "S2", note: "label size, justification, italic and bold" }),
  rule("label>property(?:>.*)?", "extend", "-", { ext: "S2", note: "label fields such as the intersheet references" }),
  rule("global_label|global_label>(?:at|shape|fields_autoplaced|uuid)", "extend", "NetLabel is sheet-local", { ext: "S2", note: "a global label joins nets across every sheet; its shape is input, output, bidirectional, tri_state or passive" }),
  rule(`global_label>${TEXT}|global_label>property(?:>.*)?`, "extend", "-", { ext: "S2" }),
  rule("hierarchical_label|hierarchical_label>(?:at|shape|fields_autoplaced|uuid)", "extend", "-", { ext: "S1", note: "joins a sheet's net to the pin of the same name on the sheet symbol that holds it" }),
  rule(`hierarchical_label>${TEXT}`, "extend", "-", { ext: "S2" }),
  rule("netclass_flag|netclass_flag>(?:at|length|shape|fields_autoplaced|uuid)|netclass_flag>property(?:>.*)?", "extend", "-", { ext: "S8", note: "a directive label that assigns a net class to the net it touches" }),
  rule(`netclass_flag>${TEXT}`, "extend", "-", { ext: "S8" }),

  // ---- sheets ----
  rule("sheet", "extend", "Project is one sheet", { ext: "S1", note: "a sheet symbol, the file it holds, its pins; one file used by several sheets is several instances" }),
  rule("sheet>(?:at|size|uuid|in_bom|on_board|dnp|exclude_from_sim|fields_autoplaced|pin|pin>(?:at|uuid)|property|instances|instances>project|instances>project>path|instances>project>path>page)", "extend", "-", { ext: "S1" }),
  rule(`sheet>(?:${STYLE}|pin>${TEXT}|property>.*)`, "extend", "-", { ext: "S1" }),
  rule("sheet_instances(?:>path(?:>page)?)?", "extend", "-", { ext: "S1", note: "the page number of each sheet instance" }),

  // ---- text and drawings ----
  rule("text|text>(?:at|uuid|exclude_from_sim)|text_box|text_box>(?:at|size|uuid|exclude_from_sim|margins)", "extend", "no schematic text", { ext: "S4", note: "free text and text boxes" }),
  rule(`text>${TEXT}|text_box>${TEXT}|text_box>${STYLE}`, "extend", "-", { ext: "S4" }),
  rule("(?:polyline|rectangle|circle|arc|bezier|ellipse)(?:>.*)?", "extend", "no schematic drawings", { ext: "S4", note: "lines, rectangles, circles, arcs and beziers on the sheet, with stroke and fill" }),
  rule("image(?:>.*)?", "extend", "-", { ext: "S4", note: "a bitmap on the sheet; large, so it goes with the model-file store (X14) and counts toward the size limit" }),
  rule("table(?:>.*)?", "extend", "-", { ext: "S4", note: "tables (KiCad 8)" }),
  rule("rule_area(?:>.*)?", "extend", "-", { ext: "S8", note: "a drawn area whose symbols are DNP, off the BOM or off the board together (KiCad 9)" }),
  rule("group>locked", "extend", "-", { ext: "S4", note: "a locked group: the editor's blocks cannot be locked" }),
  rule("group(?:>.*)?", "native", "SchematicBlock", { effort: "S", note: "a KiCad schematic group is a named set of items; symbols become a block, other members need S4" }),
  rule("net_chain(?:>.*)?", "report", "-", { note: "net chains are KiCad 11 development" }),
]

/** The first rule that covers the whole path of a schematic node, or null. */
export function decisionForSch(path) {
  for (const r of RULES_SCH) if (r.path.test(path)) return r
  return null
}

// ---- value atoms of a schematic ----

const YES_NO = ["yes", "no", "true", "false"]
const atoms = (path, values, skip = []) => ({ path: new RegExp(`^(${path})$`), values: new Set(values), skip })

export const ATOMS_SCH = [
  atoms("lib_symbols>symbol>symbol>pin", ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect", "line", "inverted", "clock", "inverted_clock", "input_low", "clock_low", "output_low", "edge_clock_high", "non_logic", "hide"]),
  atoms("lib_symbols>symbol>symbol>pin>alternate", ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect", "line", "inverted", "clock", "inverted_clock", "input_low", "clock_low", "output_low", "edge_clock_high", "non_logic"], [1]),
  atoms("lib_symbols>symbol>power", ["global", "local"]),
  atoms("lib_symbols>symbol>(?:in_bom|on_board|in_pos_files|exclude_from_sim|duplicate_pin_numbers_are_jumpers)", YES_NO),
  atoms("lib_symbols>symbol>pin_(?:names|numbers)", ["hide"]),
  atoms("lib_symbols>symbol>pin_(?:names|numbers)>hide", YES_NO),
  atoms("(?:lib_symbols>symbol>symbol>(?:arc|circle|polyline|rectangle|bezier)|rectangle|circle|polyline|arc|text_box|table>cells>table_cell|sheet|rule_area>polyline)>fill>type", ["none", "outline", "background", "color"]),
  atoms("(?:.*>)?stroke>type", ["default", "dash", "dot", "dash_dot", "dash_dot_dot", "solid"]),
  atoms("(?:global_label|hierarchical_label)>shape", ["input", "output", "bidirectional", "tri_state", "passive"]),
  atoms("netclass_flag>shape", ["dot", "round", "diamond", "rectangle"]),
  atoms("sheet>pin", ["input", "output", "bidirectional", "tri_state", "passive"], [1]),
  atoms("symbol>mirror", ["x", "y"]),
  atoms("symbol>(?:in_bom|on_board|dnp|exclude_from_sim|in_pos_files|fields_autoplaced)", YES_NO),
  atoms("sheet>(?:in_bom|on_board|dnp|exclude_from_sim|fields_autoplaced)", YES_NO),
  atoms("(?:.*>)?effects>justify", ["left", "right", "top", "bottom", "mirror"]),
  atoms("(?:.*>)?effects>font", ["bold", "italic"]),
  atoms("(?:.*>)?effects>hide", YES_NO),
  atoms("(?:.*>)?effects", ["hide"]),
  atoms("(?:.*>)?property>(?:hide|do_not_autoplace|show_name)", YES_NO),
  atoms("(?:label|global_label|hierarchical_label|netclass_flag)>fields_autoplaced", YES_NO),
  atoms("(?:symbol|sheet)>instances>project>path>variant>(?:dnp|exclude_from_sim|in_bom|on_board|in_pos_files)", YES_NO),
  atoms("rule_area>(?:dnp|exclude_from_sim|in_bom|on_board)", YES_NO),
  atoms("text>exclude_from_sim|text_box>exclude_from_sim", YES_NO),
  atoms("table>border>(?:external|header)", YES_NO),
  atoms("table>separators>(?:cols|rows)", YES_NO),
  atoms("table>cells>table_cell>exclude_from_sim", YES_NO),
  atoms("lib_symbols>symbol>symbol>text>effects>hide", YES_NO),
]

// ---- keywords of KiCad's schematic list that no corpus file uses ----

const token = (names, decision, ext, note) => ({ names: names.split(" "), decision, ext, note })

export const TOKENS_SCH = [
  token("kicad_sch kicad_symbol_lib", "native", "", "root lists of a schematic and of a symbol library"),
  token("ellipse ellipse_arc major_radius minor_radius rotation_angle start_angle end_angle", "extend", "S6", "ellipses (KiCad 11 development)"),
  token("pin_map pin_map_override pin_maps pin_merge pin_rename pin_del hint_alt_swap hint_pin_swap jumper_pin_groups named_map map property_del", "extend", "S5", "pin-to-pad maps, merged and renamed pins and jumper pin groups (KiCad 10 and 11 development)"),
  token("variant", "extend", "S9", "schematic variants (KiCad 10)"),
  token("delegate symbol_override custom_property default_instance", "extend", "S9X", "symbol overrides and custom properties (KiCad 11 development)"),
  token("net_chain nets from to net_class", "report", "", "net chains (KiCad 11 development)"),
  token("body_style body_styles demorgan convert", "extend", "S5", "De Morgan and body styles"),
  token("alternate", "extend", "S5", "pin alternate functions"),
  token("clock clock_low edge_clock_high inverted inverted_clock input_low output_low non_logic line", "extend", "S6", "pin graphic styles"),
  token("bidirectional tri_state passive input output free unspecified power_in power_out open_collector open_emitter no_connect", "extend", "S5", "pin electrical types and label shapes; the editor's PinDef.kind has fewer kinds, ERC needs all"),
  token("directive_label netclass_flag", "extend", "S8", "directive labels"),
  token("show_name field fields", "extend", "S5", "field flags"),
  token("do_not_autoplace fields_autoplaced private", "not-needed", "", "KiCad's autoplacing flags, and the private items of a symbol, which KiCad draws in its symbol editor only"),
  token("associated_footprints", "native", "", "a symbol library's footprint filters, kept as a property"),
  token("in_pos_files exclude_from_sim in_bom on_board dnp", "extend", "S7", "symbol flags"),
  token("hatch cross_hatch reverse_hatch", "extend", "S6", "hatched fills of shapes (KiCad 9)"),
  token("arrow arrow_open diamond dot round square cross start_shape end_shape tri", "extend", "S4", "line end shapes and flag shapes (KiCad 11 development)"),
  token("bitmap data checksum", "extend", "S4", "images and embedded data"),
  token("sheet_instances symbol_instances instances", "extend", "S1", "instance data"),
  token("rule_area", "extend", "S8", "rule areas"),
  token("anchor line_spacing locked bezier", "extend", "S4", "text anchors and line spacing, locked drawings, bezier curves"),
  token("angles", "extend", "S6", "arc angles of a symbol or sheet shape"),
  token("edit", "not-needed", "", "an editing timestamp"),
  token("entry", "extend", "S3", "bus entry"),
  token("extends group", "native", "", "symbol inheritance, resolved when the symbol is read, and schematic groups (symbols become a block)"),
  token("host", "not-needed", "", "the program that wrote the file, removed from the format at stamp 20200827"),
  token("identity library_default mode pin_map passthrough required atomic", "extend", "S5", "pin-to-pad map overrides and pin groups (KiCad 10 and 11 development)"),
  token("iref", "extend", "S2", "the old intersheet reference field of a global label (KiCad 5 formats)"),
  token("local", "extend", "S5", "local power symbols (KiCad 9: a power symbol that stays on its sheet)"),
  token("unconnected", "native", "", "the old name of the no_connect pin type (renamed at stamp 20210123): read as no_connect"),
  token("portrait", "not-needed", "", "page orientation"),
]

// ---- KiCad 4 and 5 schematics (`EESchema Schematic File Version 2 to 5`) ----
// Line types of the text format, as the census saw them and as the file's own `$` blocks name them.

const line = (name, decision, ext, note) => ({ name, decision, ext, note })

export const LEGACY_SCH = [
  line("EESchema Schematic File Version N", "native", "", "version 1 (12 files, old Latin-1 KiCad 2012 files), 2 (KiCad 4), 4 and 5 (KiCad 5); read as UTF-8, else as Latin-1 (3 files in the corpus)"),
  line("LIBS:name, EELAYER n m, EELAYER END, $Descr size, Sheet n m, Title, Date, Rev, Comp, Comment1..9, encoding", "native", "", "page, sheet count and title block; the page size is not needed"),
  line("$Comp ... $EndComp", "native", "", "one symbol instance"),
  line("L lib:name ref", "native", "", "the library symbol and the reference; without a `lib:` prefix (KiCad 4) the name is searched in the cache and the project libraries"),
  line("U unit convert timestamp", "extend", "S5", "the unit and De Morgan body style of a multi-unit symbol, and the timestamp that links the footprint (`(path /TIMESTAMP)`)"),
  line("P x y; orientation matrix `a b c d`", "extend", "S5", "position; the matrix gives the quarter turn and any mirror"),
  line("AR Path=\"/sheetTS/compTS\" Ref=\"U1\" Part=\"1\"", "extend", "S1", "the reference of one use of a sheet; 220 comps in 8 files of the corpus, 48 with several"),
  line("F n \"text\" H|V x y size flags justify style \"name\"", "extend", "S5", "fields with their place, size, visibility, justification and style; field 0 is the reference, 1 the value, 2 the footprint, 3 the datasheet"),
  line("Wire Wire Line / Wire Bus Line / Wire Notes Line (and the segment on the next line)", "extend", "S3", "wires map to Wire; bus lines to S3 buses; notes lines are drawings (S4)"),
  line("Entry Wire Line / Entry Bus Bus (and the segment)", "extend", "S3", "bus entries"),
  line("Connection ~ x y", "native", "", "an explicit junction"),
  line("NoConn ~ x y", "native", "", "a no-connect flag"),
  line("Text Label|GLabel|HLabel|Notes x y orientation size shape (and the text on the next line)", "extend", "S2", "Label is a local label (native), GLabel a global one, HLabel a hierarchical one, Notes free text (S4); GLabel and HLabel carry a shape"),
  line("$Sheet ... $EndSheet (S, U timestamp, F0 name, F1 file, F2.. pins)", "extend", "S1", "sheets with pins; a file may be used twice"),
  line("$Bitmap ... $EndBitmap", "extend", "S4", "an image as hex lines"),
  line("Polyline / Line / Rect / Circle / Arc inside a sheet", "extend", "S4", "drawings"),
  line("Kmarq (an ERC marker)", "not-needed", "", "an ERC result KiCad recomputes"),
  line("name-cache.lib and name.cache.lib (EESchema-LIBRARY Version 2.3 and 2.4)", "native", "", "the symbols the schematic uses: DEF, ALIAS, F fields, DRAW with A, C, P, S, T, X records; multi-unit symbols and De Morgan are common in them (51 of 163 libraries have some)"),
  line("name.pro ([general], [eeschema], [pcbnew], [cvpcb] and LibName1..n)", "native", "", "net classes are in the board in KiCad 5; the .pro lists which libraries a schematic uses"),
  line("name.net and name.cmp (netlist and the footprint assignment by timestamp)", "native", "", "a second source for the reference to footprint link, when the schematic has no footprint field"),
]
