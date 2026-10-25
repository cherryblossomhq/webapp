// What the importer does with every node and every value atom of a KiCad board, as data. The gap
// list in `docs/kicad-import.md` and `docs/kicad-import-nodes.md` is generated from it
// (`gap-table.mjs`), and Phase 1's reader is meant to read this table (or a typed copy) so that
// "every node is imported, deliberately not needed, or reported" is a lookup and not a habit. A
// node or atom the census sees that nothing here covers fails the run, and
// `decisions.check.mjs` pins the decisions that matter most.
//
// A rule matches the WHOLE path of a node from the root, `zone>polygon>pts>xy` or
// `footprint>pad>drill>offset`, because the same name means different things in different places
// (`pts` is a zone outline in one and an arrow in another; `dimension` is a board object at the root
// and a report entry inside a footprint). `module` is read as `footprint`: the reader goes by the
// token in any version, not by the version stamp. The first rule that matches wins, so specific
// rules come before general ones.
//
// decision:
//   native      goes into the model as it is today (a conversion at most)
//   extend      the model has to grow first; `ext` names the extension (X1 to X23 in the doc)
//   not-needed  deliberately not imported; `note` is the reason, which the importer lists in code
//   report      cannot be represented, even after the extensions; it goes into the import report

const rule = (path, decision, today, extra = {}) => ({ path: new RegExp(`^(${path})$`), decision, today, ...extra })

const ANY_GFX = "gr_(?:line|arc|circle|rect|poly|curve)"
const FP_GFX = "footprint>fp_(?:line|arc|circle|rect|poly|curve)"
const GFX = `(?:${ANY_GFX}|${FP_GFX})`

export const RULES = [
  // ---- nodes of KiCad's list that no corpus board has: their place from the board writer, so every
  // extend or native token of TOKENS has a path rule (decisions.check.mjs checks it) ----
  rule("setup>stackup>(?:edge_connector|edge_plating|castellated_pads|copper_finish|dielectric_constraints)", "extend", "BoardDef.thickness only", { ext: "X1" }),
  rule("setup>stackup>layer>(?:dielectric_model|constant|djordjevic_sarkar|spec_frequency|epsilon_r|loss_tangent)", "extend", "-", { ext: "X1", note: "dielectric models of the stackup (KiCad 11 development)" }),
  rule("(?:footprint>)?zone>(?:zone_type|fill>(?:hatch_smoothing_level|hatch_smoothing_value)|hatch_smoothing_level|hatch_smoothing_value)", "extend", "-", { ext: "X3", note: "hatched fill smoothing and the zone's kind" }),
  rule("(?:footprint>)?zone>fill>thieving>(?:type|pattern)", "extend", "-", { ext: "X3", note: "thieving patterns: dots or squares" }),
  rule("footprint>pad>(?:front_post_machining|back_post_machining|post_machining)(?:>(?:mode|depth|size|angle))?", "extend", "-", { ext: "X22", note: "counterbore or countersink, with depth, size and angle" }),
  rule("(?:gr_ellipse|gr_ellipse_arc|footprint>fp_ellipse|footprint>fp_ellipse_arc)(?:>(?:center|major_radius|minor_radius|rotation_angle|start_angle|end_angle|layer|width|stroke|stroke>.*|fill|locked|net|uuid))?", "extend", "-", { ext: "X8", note: "ellipses and elliptical arcs (KiCad 11 development; a small addition to X8)" }),
  rule("footprint>fp_text_box(?:>.*)?", "extend", "-", { ext: "X9", note: "a footprint's text box (KiCad 7)" }),
  rule("(?:gr_text|gr_text_box|footprint>fp_text|footprint>fp_text_box|footprint>property)>(?:keep_upright|line_spacing|background|effects>(?:line_spacing|href))", "extend", "BoardText", { ext: "X9" }),
  rule("(?:footprint>)?table>cells>table_cell>ij", "extend", "-", { ext: "X9", note: "a table cell's row and column" }),
  rule("footprint>private_layers(?:><layer number>)?", "extend", "-", { ext: "X8", note: "layers a footprint draws on that the board does not show (KiCad 7)" }),
  rule("(?:[^>]+>)*custom_property(?:>.*)?", "extend", "-", { ext: "X23", note: "custom properties on any board object (KiCad 11 development)" }),
  rule("(?:footprint>)?variants?>(?:variant>)?(?:description|exclude_from_sim)|footprint>variant>(?:description|exclude_from_sim)", "extend", "-", { ext: "X23" }),
  rule("point(?:>(?:at|layer|size|uuid))?", "extend", "-", { ext: "X23", note: "PCB points at the board level (KiCad 10)" }),
  rule("footprint>units>unit>pins(?:>num)?", "extend", "-", { ext: "X23" }),
  rule("(?:footprint>)?group>lib_id", "extend", "-", { ext: "X12", note: "the design block a group was made from (KiCad 10)" }),
  rule("(?:footprint>)?zone>(?:link|connected_routing|group_items|locked_items|other_items|start_end_only|driving|all|addsublayer)", "extend", "-", { ext: "X20", note: "rule area and copy-layout options (KiCad 9 and 10)" }),
  rule("net_chains(?:>(?:net_chain(?:>(?:name|nets|terminal_pad|net_class|members))?))?", "extend", "-", { ext: "X21", note: "net chains for length tuning (KiCad 11 development)" }),
  rule("footprint>pad>(?:terminal_pad|bevelled|thru)", "extend", "-", { ext: "X7", note: "pad corner style and padstack words" }),
  rule("footprint>pad>sim_electrical_type|footprint>attr>exclude_from_sim", "report", "-", { note: "simulation roles of pads and parts (KiCad 11 development); this editor does no circuit simulation on the board" }),
  rule("grid_item(?:>(?:at|polar|linear|extent|spacing|tick_interval|affects|affects>(?:cursor|routing|placement)|layer|uuid))?", "report", "-", { note: "grid items on the board (KiCad 11 development, stamp 20260728): not released, the format may change" }),
  rule("footprint>(?:model>)?extruded(?:>.*)?", "report", "-", { note: "an extruded 3D body drawn from a footprint shape (KiCad 11 development): not released" }),

  // ---- the file ----
  rule("version", "native", "-", { effort: "S", note: "picks the reader's switches (section 3.3 of the doc); text that starts PCBNEW-BOARD is refused with a message" }),
  rule("generator|generator_version|host", "native", "project property 'Imported from'", { effort: "S" }),
  rule("general", "native", "BoardDef.thickness", { effort: "S" }),
  rule("general>thickness", "native", "BoardDef.thickness", { effort: "S" }),
  rule("general>legacy_teardrops", "extend", "-", { ext: "X3", note: "says the board's teardrop zones come from KiCad 7's generator and are not regenerated; kept with the teardrop zones" }),
  rule("general>(?:area|drawings|links|modules|nets|no_connects|tracks|zones)", "not-needed", "-", { note: "counts and extents KiCad recomputes on save" }),
  rule("page|paper", "not-needed", "-", { note: "sheet size of KiCad's drawing frame, which this editor does not print" }),
  rule("title_block|title_block>(?:title|rev|company|date|comment)", "native", "Project.properties", { effort: "S" }),
  rule("property", "native", "Project.properties", { effort: "S", note: "board properties (KiCad 8 and later)" }),
  rule("layers|layers><layer number>", "extend", "CopperLayer is top or bottom", { ext: "X1", note: "copper layers are the table rows typed signal, power, mixed or jumper, first row front, last row back; technical layers map to fixed ones; user layers keep their names (X8)" }),

  // ---- setup ----
  rule("setup", "native", "DesignRules", { effort: "M", note: "see the setup rows" }),
  rule("setup>(?:last_trace_width|trace_min|trace_clearance|via_size|via_drill|via_min_size|via_min_drill|zone_clearance|edge_clearance|pad_to_mask_clearance|pad_to_paste_clearance|user_trace_width|user_via)", "native", "DesignRules (traceWidth, minTraceWidth, clearance, viaDiameter, viaDrill, minDrill, pourClearance, edgeClearance, maskExpansion, pasteExpansion, preferredWidths)", { effort: "S" }),
  rule("setup>(?:pad_to_paste_clearance_ratio|solder_mask_min_width|allow_soldermask_bridges_in_footprints|zone_45_only|max_error|hole_to_hole_min|clearance_min|through_hole_min|via_min_annulus|user_diff_pair|creepage)", "extend", "DesignRules has no field", { ext: "X10", note: "design rule values the checks need once copper, vias and zones are extended" }),
  rule("setup>(?:uvia_size|uvia_drill|uvia_min_size|uvia_min_drill|uvias_allowed|blind_buried_vias_allowed)", "extend", "DesignRules has no field", { ext: "X5", note: "microvia and blind or buried via rules" }),
  rule("setup>(?:stackup|stackup>.*)", "extend", "BoardDef.thickness only", { ext: "X1", note: "layers with thickness, material, epsilon r, loss tangent, copper finish, edge plating, castellated pads, dielectric constraints" }),
  rule("setup>(?:tenting|tenting>(?:front|back))", "extend", "DesignRules.tentVias (one flag)", { ext: "X5", note: "front and back via tenting" }),
  rule("setup>(?:covering|plugging|capping|filling)(?:>(?:front|back))?", "extend", "-", { ext: "X22", note: "via protection (IPC-4761, KiCad 10)" }),
  rule("setup>(?:aux_axis_origin|grid_origin)", "not-needed", "-", { note: "origin of KiCad's output coordinates; the geometry does not change with it; kept as a project property so the KiCad export writes it back" }),
  rule("setup>(?:pcbplotparams|pcbplotparams>.*|defaults|defaults>.*|drill_symbol_profile|drill_symbol_profile>.*|zone_defaults|pcb_text_size|pcb_text_width|mod_edge_width|mod_text_size|mod_text_width|edge_width|segment_width|pad_size|pad_drill|visible_elements|extension_.*|fab_layers_.*)", "not-needed", "-", { note: "plot settings and KiCad's defaults for the next object a user draws: they only steer KiCad's own outputs and editing" }),

  // ---- nets ----
  rule("net", "native", "net names become labels on a generated schematic", { effort: "M", note: "KiCad 10 stops writing net numbers: the name is the key. Names carry escapes such as {slash} and ~{overbar}, decoded when read" }),
  rule("net_class|net_class>.*", "extend", "DesignRules.netWidths only", { ext: "X10", note: "KiCad 5 keeps net classes in the board; KiCad 6 and later in .kicad_pro" }),

  // ---- tracks and vias ----
  rule("segment", "native", "Trace polyline (consecutive same-layer, same-width segments of one net are joined)", { effort: "M" }),
  rule("segment>(?:start|end|width|layer|locked)", "native", "Trace", { effort: "S" }),
  rule("(?:segment|via|arc)>status", "native", "Trace.locked", { effort: "S", note: "bit 0x40000 is KiCad 4 and 5's track lock, which KiCad 6 and later read and drop; kept as locked. The other bits are KiCad edit flags" }),
  rule("(?:segment|arc|via)>net", "extend", "traces take their net from what they touch", { ext: "X13" }),
  rule("(?:segment|arc|via)>(?:tstamp|uuid)", "not-needed", "-", { note: "KiCad's object identity" }),
  rule("(?:segment|arc)>(?:layers|solder_mask_margin)", "extend", "-", { ext: "X8", note: "copper exposed through the mask (KiCad 9)" }),
  rule("arc", "extend", "Trace is a polyline", { ext: "X4" }),
  rule("arc>(?:start|mid|end|width|layer|locked)", "extend", "Trace is a polyline", { ext: "X4" }),
  rule("via", "native", "Via (through only)", { effort: "S", note: "through vias; blind, buried and micro need X5" }),
  rule("via>(?:at|size|drill|locked)", "native", "Via", { effort: "S" }),
  rule("via>layers", "extend", "Via is through only", { ext: "X5", note: "layer pair; a blind via with two inner layers is a buried one" }),
  rule("via>(?:free|remove_unused_layers|keep_end_layers|padstack(?:>.*)?|tenting(?:>(?:front|back))?)", "extend", "-", { ext: "X5", note: "via stacks (per-layer sizes), tenting and unused-pad removal" }),
  rule("via>(?:teardrops(?:>.*)?|zone_layer_connections)", "extend", "-", { ext: "X3" }),
  rule("via>(?:capping|covering|plugging|filling)(?:>(?:front|back))?", "extend", "-", { ext: "X22", note: "via protection (KiCad 10)" }),
  rule("via>(?:backdrill|tertiary_drill)(?:>.*)?", "extend", "-", { ext: "X22", note: "backdrill specifications" }),

  // ---- zones ----
  rule("(?:footprint>)?zone", "extend", "Zone is a whole-board pour on one layer", { ext: "X3" }),
  rule("(?:footprint>)?zone>(?:net|net_name|layer|layers|name|locked|priority|min_thickness|filled_areas_thickness|hatch|connect_pads|connect_pads>clearance|fill|keepout|keepout>(?:tracks|vias|pads|copperpour|footprints)|polygon|polygon>pts|polygon>pts>xy|polygon>pts>arc|polygon>pts>arc>(?:start|mid|end))", "extend", "Zone is a whole-board pour on one layer", { ext: "X3" }),
  rule("(?:footprint>)?zone>fill>(?:arc_segments|hatch_border_algorithm|hatch_gap|hatch_min_hole_area|hatch_orientation|hatch_thickness|island_area_min|island_removal_mode|mode|radius|smoothing|thermal_bridge_width|thermal_gap)", "extend", "ThermalRelief and spokes are board-wide", { ext: "X3" }),
  rule("(?:footprint>)?zone>fill>thieving(?:>.*)?", "extend", "-", { ext: "X3", note: "copper thieving fill (KiCad 11 development)" }),
  rule("(?:footprint>)?zone>attr(?:>teardrop(?:>type)?)?", "extend", "-", { ext: "X3", note: "a teardrop is a copper zone whose outline is its fill" }),
  rule("(?:footprint>)?zone>property(?:>.*)?", "extend", "-", { ext: "X3", note: "zone properties (hatch position, KiCad 10)" }),
  rule("(?:footprint>)?zone>placement(?:>(?:component_class|enabled|sheetname))?", "extend", "-", { ext: "X20", note: "placement rule area: where parts of a sheet or class may sit (KiCad 9)" }),
  rule("(?:footprint>)?zone>filled_polygon(?:>.*)?", "not-needed", "the pour is filled again by model/pour.ts", { note: "a filled polygon is KiCad's own result of its fill, which it recomputes on every refill; ours is filled the same way from the outline and rules, and the import report says so. This is the one place the format is itself an approximation" }),
  rule("(?:footprint>)?zone>fill_segments(?:>.*)?", "not-needed", "-", { note: "hatch fill segments KiCad computed" }),
  rule("(?:footprint>)?zone>(?:tstamp|uuid)", "not-needed", "-", { note: "KiCad's object identity" }),

  // ---- graphics, on the board and in footprints ----
  rule(GFX, "extend", "BoardDef is a rounded rectangle; FootprintDef has silk polylines and a courtyard box", { ext: "X8", note: "on Edge.Cuts a board line is the outline and its cutouts (X2); on every other layer a shape (X8)" }),
  rule(`${GFX}>(?:start|end|mid|center|layer|layers|stroke|width|fill|pts|locked|net|radius|solder_mask_margin)`, "extend", "-", { ext: "X8" }),
  rule(`${GFX}>stroke>(?:type|width|color)`, "extend", "-", { ext: "X8", note: "line width, dash style and colour (KiCad 10)" }),
  rule(`${GFX}>pts>(?:xy|arc|arc>(?:start|mid|end))`, "extend", "-", { ext: "X8", note: "polygon points; an arc inside a polygon outline since KiCad 6" }),
  rule(`${GFX}>(?:start_shape|end_shape)(?:>.*)?`, "extend", "-", { ext: "X8", note: "line end shapes (KiCad 10)" }),
  rule("gr_arc>angle|footprint>fp_arc>angle", "native", "-", { effort: "S", note: "the legacy arc form: (start centre) (end first end) (angle clockwise sweep), converted to start, mid and end; stamp 20210925 and older" }),
  rule("gr_line>angle", "not-needed", "-", { note: "a leftover token on KiCad 4 and 5 lines with no meaning" }),
  rule(`${GFX}>(?:tstamp|uuid|status)`, "not-needed", "-", { note: "KiCad's object identity and edit flags" }),
  rule("target(?:>(?:at|layer|size|tstamp|width))?", "extend", "-", { ext: "X8", note: "a board target mark, lines on its layer" }),

  // ---- text ----
  rule("gr_text|gr_text_box", "extend", "BoardText: quarter turns, silk only", { ext: "X9", note: "text on any layer, any angle, mirrored, justified, bold or italic, knockout; text boxes (KiCad 7 and later)" }),
  rule("(?:gr_text|gr_text_box|footprint>fp_text|footprint>property|dimension>gr_text|footprint>dimension>gr_text)>(?:at|layer|effects|hide|unlocked|locked|uuid|tstamp|border|end|start|margins|knockout|stroke|stroke>(?:type|width)|effects>justify|effects>font|effects>font>(?:size|thickness|bold|italic|face))", "extend", "BoardText", { ext: "X9" }),
  rule("(?:gr_text|gr_text_box|footprint>fp_text|footprint>property)>render_cache(?:>polygon(?:>pts(?:>xy)?)?)?", "extend", "-", { ext: "X19", note: "the outlines KiCad drew a TrueType text with; they decide the silkscreen shapes, so they are stored and plotted" }),
  rule("embedded_fonts|footprint>embedded_fonts", "extend", "-", { ext: "X19", note: "the fonts a board embeds (KiCad 9); needed to redraw its text outlines" }),
  rule("(?:footprint>)?table(?:>.*)?|barcode(?:>.*)?|drill_chart(?:>.*)?|drill_map(?:>.*)?", "extend", "-", { ext: "X9", note: "tables (KiCad 9), barcodes (KiCad 10), and drill charts and maps, which are tables and drawings KiCad generates from the drill data" }),

  // ---- dimensions ----
  rule("(?:footprint>)?dimension(?:>.*)?", "extend", "-", { ext: "X11", note: "aligned, orthogonal, radial, leader and center dimensions; KiCad 5 writes feature and arrow lines; also inside footprints since KiCad 7" }),

  // ---- footprints ----
  rule("footprint", "native", "ComponentInstance and a land in Project.footprints", { effort: "L", note: "the token is footprint from stamp 20201115 and module before, and the reader goes by the token" }),
  rule("footprint>at", "extend", "ComponentInstance.pcb.rot is a quarter turn", { ext: "X6" }),
  rule("footprint>transform(?:>(?:translate|rotate|scale))?", "extend", "-", { ext: "X6", note: "from stamp 20260616 a footprint has translate, rotate and scale in place of at; a scale other than 1 is reported" }),
  rule("footprint>layer", "native", "ComponentInstance.pcb.side", { effort: "S", note: "back side means the layer table's last copper row, whatever it is called" }),
  rule("footprint>(?:locked|placed)", "native", "ComponentInstance.pcb.locked", { effort: "S" }),
  rule("footprint>attr", "extend", "ComponentInstance.props only", { ext: "X15", note: "smd, through_hole, virtual, board_only, exclude_from_pos_files, exclude_from_bom, dnp, allow_soldermask_bridges, allow_missing_courtyard; no attr before stamp 20200826 means through-hole" }),
  rule("footprint>(?:descr|tags)", "native", "ComponentInstance.props (a KiCad 5 tag 'net tie ...' also makes a net tie)", { effort: "S" }),
  rule("footprint>(?:path|sheetname|sheetfile)", "native", "kept to link symbol and footprint", { effort: "S", note: "the link to the schematic symbol (Phase 3)" }),
  rule("footprint>(?:tstamp|uuid|tedit|version|generator|generator_version)", "not-needed", "-", { note: "KiCad's object identity and edit time" }),
  rule("footprint>(?:net_tie_pad_groups|duplicate_pad_numbers_are_jumpers|jumper_pad_groups|jumper_pad_groups><layer number>)", "extend", "PartDef.padAlias for pads that share a pin", { ext: "X15", note: "net ties let two nets meet at a footprint without a short; jumper groups join pads inside the part" }),
  rule("footprint>(?:clearance|solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|solder_paste_ratio|zone_connect)", "extend", "-", { ext: "X7", note: "footprint-wide overrides, copied onto its pads; in files up to stamp 20240201 a zero means inherit" }),
  rule("footprint>(?:autoplace_cost180|autoplace_cost90|height)", "not-needed", "-", { note: "KiCad's legacy auto-placer hints" }),
  rule("footprint>(?:fp_text|property)", "extend", "auto-placed silk reference and value", { ext: "X9", note: "the property's value is a component property (native); its text and where it sits are X9. Before 20260616 a text angle is absolute in the board frame" }),
  rule("footprint>model", "native", "Model3D (source kicad or file)", { effort: "M", note: "stock KiCad library paths map to the kicad source, the rest are listed in the report; before stamp 20171114 the offset is in inches" }),
  rule("footprint>model>(?:at|offset|scale|rotate)(?:>xyz)?|footprint>model>(?:hide|opacity|type|uuid|layer|color|body_pcb_gap|material|overall_height)", "native", "Model3D.offset, rotation, scale", { effort: "M" }),
  rule("footprint>group(?:>.*)?", "extend", "-", { ext: "X12" }),
  rule("footprint>embedded_files(?:>.*)?|embedded_files(?:>.*)?", "report", "-", { note: "founder decision, 24 October 2026: no 3D models packed inside the file for now. Each embedded file (KiCad 9) is a report entry named per file, \"3D model embedded in the KiCad file was not brought in\", and never dropped silently; a model referenced by path or library name is still imported as a model assignment where the editor can resolve it" }),
  rule("footprint>component_classes(?:>class)?", "extend", "-", { ext: "X20", note: "component classes (KiCad 9) that placement rule areas refer to" }),
  rule("footprint>units(?:>unit(?:>(?:name|pins))?)?", "extend", "-", { ext: "X23", note: "footprint units, which pins belong to which unit (KiCad 10)" }),
  rule("footprint>point(?:>(?:at|layer|size|uuid))?", "extend", "-", { ext: "X23", note: "PCB points (KiCad 10); in a footprint before 20260616 in board frame" }),
  rule("footprint>variant(?:>.*)?|variants|variants>.*", "extend", "-", { ext: "X23", note: "board variants with per-footprint overrides (KiCad 10)" }),
  rule("footprint>constraint(?:>.*)?|constraint(?:>.*)?", "report", "-", { note: "geometric constraints exist only in KiCad 11 development, not in any release" }),

  // ---- pads ----
  rule("footprint>pad", "extend", "PadDef: rect, circle, pill, polygon; no rotation", { ext: "X7" }),
  rule("footprint>pad>(?:at|size|layers|drill|drill>offset|options|options>(?:anchor|clearance)|primitives|rect_delta|roundrect_rratio|chamfer|chamfer_ratio|padstack|padstack>mode)", "extend", "PadDef: rect, circle, pill, polygon; no rotation", { ext: "X7" }),
  rule("footprint>pad>padstack>layer(?:>(?:chamfer|chamfer_ratio|roundrect_rratio|shape|size))?", "extend", "-", { ext: "X7", note: "complex padstacks: a shape per layer (KiCad 9)" }),
  rule("footprint>pad>primitives>.*", "extend", "-", { ext: "X7", note: "custom pad shapes: polygons, circles, arcs, rectangles, lines, with line widths" }),
  rule("footprint>pad>net", "native", "pin of the generated schematic", { effort: "M" }),
  rule("footprint>pad>(?:pinfunction|pintype)", "native", "PinDef.name and kind", { effort: "S" }),
  rule("footprint>pad>(?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance|thermal_bridge_width|thermal_gap|thermal_width|thermal_bridge_angle|zone_connect|tenting(?:>(?:front|back))?|property)", "extend", "-", { ext: "X7", note: "per-pad overrides and fabrication properties (BGA, fiducial, test point, heat sink, castellated, press-fit)" }),
  rule("footprint>pad>(?:remove_unused_layers|keep_end_layers|zone_layer_connections)", "extend", "-", { ext: "X7", note: "needs X1 and X3 too" }),
  rule("footprint>pad>teardrops(?:>.*)?", "extend", "-", { ext: "X3", note: "teardrop parameters on pads (KiCad 8)" }),
  rule("footprint>pad>(?:die_length|die_delay)", "extend", "-", { ext: "X21", note: "package length or delay, which length tuning adds to a track's" }),
  rule("footprint>pad>(?:backdrill|tertiary_drill|front_post_machining|back_post_machining)(?:>.*)?", "extend", "-", { ext: "X22", note: "advanced drilling (KiCad 10)" }),
  rule("footprint>pad>(?:locked|tstamp|uuid)", "not-needed", "-", { note: "pad lock is a session preference since KiCad 6; identity" }),

  // ---- the rest of the board ----
  rule("group(?:>.*)?", "extend", "SchematicBlock is schematic-only", { ext: "X12" }),
  rule("image(?:>.*)?", "extend", "-", { ext: "X14", note: "reference image: a bitmap on a layer" }),
  rule("generated(?:>.*)?", "extend", "-", { ext: "X21", note: "tuning patterns and via arrays: kept as a named group of tracks with their parameters, so a pattern can be re-tuned or taken apart" }),
]

/** The first rule that covers the whole path, or null. `module` is `footprint`. */
export function decisionFor(path) {
  const p = path.replace(/^module(?=$|>)/, "footprint")
  for (const r of RULES) if (r.path.test(p)) return r
  return null
}

// ---- value atoms ----
// The bare words (not numbers, not quoted strings) that may stand in a list, by the path of the
// list. The census collects the atoms it finds in these lists, and a word that is not here fails
// the run; the reader reports any atom it does not know, never skips it. `skip` lists positions
// that hold a name or a number the file's author chose (the pad's number at position 1).

const YES_NO = ["yes", "no", "true", "false"]
const atoms = (path, values, skip = []) => ({ path: new RegExp(`^(${path})$`), values: new Set(values), skip })

export const ATOMS = [
  atoms("(?:module|footprint)>pad", ["thru_hole", "smd", "connect", "np_thru_hole", "circle", "rect", "oval", "trapezoid", "roundrect", "custom", "locked"], [1]),
  atoms("(?:module|footprint)>attr", ["smd", "through_hole", "virtual", "board_only", "exclude_from_pos_files", "exclude_from_bom", "allow_missing_courtyard", "allow_soldermask_bridges", "dnp", "exclude_from_sim"]),
  atoms("(?:module|footprint)", ["locked", "placed"], [1]),
  atoms("(?:module|footprint)>fp_text", ["reference", "value", "user", "hide"], [2]),
  atoms("(?:module|footprint)>(?:fp_line|fp_arc|fp_circle|fp_rect|fp_poly|fp_curve)", ["locked"]),
  atoms("gr_(?:line|arc|circle|rect|poly|curve|text)", ["locked"], [1]),
  atoms("segment|arc", ["locked"]),
  atoms("via", ["blind", "buried", "micro", "locked"]),
  atoms("zone", ["locked"]),
  atoms("(?:module|footprint)>zone", ["locked"]),
  atoms("(?:(?:module|footprint)>)?zone>connect_pads", ["yes", "no", "thru_hole_only"]),
  atoms("(?:(?:module|footprint)>)?zone>hatch", ["none", "edge", "full"]),
  atoms("(?:(?:module|footprint)>)?zone>fill", ["yes", "no"]),
  atoms("(?:(?:module|footprint)>)?zone>fill>mode", ["hatch", "solid", "segment", "thieving"]),
  atoms("(?:(?:module|footprint)>)?zone>fill>hatch_border_algorithm", ["hatch_thickness", "min_thickness"]),
  atoms("(?:(?:module|footprint)>)?zone>fill>smoothing", ["none", "chamfer", "fillet"]),
  atoms("(?:(?:module|footprint)>)?zone>keepout>(?:tracks|vias|pads|copperpour|footprints)", ["allowed", "not_allowed"]),
  atoms("(?:(?:module|footprint)>)?zone>attr>teardrop>type", ["padvia", "track_end"]),
  atoms("(?:(?:module|footprint)>)?zone>placement>enabled", YES_NO),
  atoms("(?:module|footprint)>pad>drill", ["oval"]),
  atoms("(?:module|footprint)>pad>options>anchor", ["rect", "circle"]),
  atoms("(?:module|footprint)>pad>options>clearance", ["outline", "convexhull"]),
  atoms("(?:module|footprint)>pad>property", ["pad_prop_bga", "pad_prop_fiducial_loc", "pad_prop_fiducial_glob", "pad_prop_castellated", "pad_prop_testpoint", "pad_prop_heatsink", "pad_prop_mechanical", "pad_prop_pressfit"]),
  atoms("(?:module|footprint)>pad>sim_electrical_type", ["source", "sink", "bidirectional", "passive", "none"]),
  atoms("(?:module|footprint)>pad>(?:front|back)_post_machining", ["counterbore", "countersink"]),
  atoms("(?:(?:module|footprint)>fp|gr)_[a-z_]+>(?:start|end)_shape>style", ["arrow", "arrow_open", "square", "round", "diamond", "dot"]),
  atoms("(?:(?:module|footprint)>)?zone>fill>thieving>type", ["dots", "squares", "hatch"]),
  atoms("(?:module|footprint)>pad>padstack>mode", ["normal", "front_inner_back", "custom"]),
  atoms("(?:module|footprint)>pad>padstack>layer>shape", ["circle", "rect", "oval", "trapezoid", "roundrect", "custom"]),
  atoms("(?:module|footprint)>pad>chamfer", ["top_left", "top_right", "bottom_left", "bottom_right"]),
  atoms("(?:module|footprint)>pad>(?:remove_unused_layers|keep_end_layers)", YES_NO),
  atoms("(?:module|footprint)>pad>primitives>gr_(?:poly|rect|circle|arc|bbox)>fill", YES_NO.concat(["none", "solid"])),
  atoms("(?:(?:module|footprint)>fp_(?:rect|circle|poly)|gr_(?:rect|circle|poly))>fill", YES_NO.concat(["none", "solid", "hatch", "reverse_hatch", "cross_hatch"])),
  atoms("(?:(?:(?:module|footprint)>fp)|gr)_[a-z_]+>stroke>type", ["default", "dash", "dot", "dash_dot", "dash_dot_dot", "solid"]),
  atoms("(?:.*>)?effects>justify", ["left", "right", "top", "bottom", "mirror"]),
  atoms("(?:.*>)?effects>font", ["bold", "italic"]),
  atoms("(?:.*>)?effects", ["hide"]),
  atoms("(?:(?:module|footprint)>)?dimension>type", ["aligned", "leader", "center", "orthogonal", "radial"]),
  atoms("(?:(?:module|footprint)>)?dimension>style>arrow_direction", ["outward", "inward"]),
  atoms("target", ["plus", "x"]),
  atoms("group", ["locked"], [1]),
  atoms("general>legacy_teardrops", YES_NO),
  atoms("layers><layer number>", ["signal", "power", "mixed", "jumper", "user", "auxiliary", "front", "hide"], [1]),
  atoms("setup>(?:zone_45_only|uvias_allowed|blind_buried_vias_allowed|allow_soldermask_bridges_in_footprints)", YES_NO),
  atoms("setup>(?:tenting|covering|plugging|capping|filling)", ["front", "back", "none", "yes", "no"]),
  atoms("net_class", [], [1, 2]),
  atoms("image", ["locked"]),
  atoms("(?:module|footprint)>model", ["hide"], [1]),
]

// ---- tokens of KiCad's own keyword file that no corpus board uses ----
// `pcb.keywords` of KiCad's source (common/pcb.keywords, 482 tokens at commit de08734) is the
// list of everything the board parser knows. The census names every node and atom the corpus
// has; these are the rest, with where they live (from the board writer) and what to do. Most are
// KiCad 11 development, which has not been released and may still change, and those are
// reported, not built.

const token = (names, decision, ext, note) => ({ names: names.split(" "), decision, ext, note })

export const TOKENS = [
  token("kicad_pcb", "native", "", "the root list; its version, generator and generator_version are read"),
  token("true false", "native", "", "boolean atoms (`(locked yes)` from stamp 20230924, `true` and `false` in a few KiCad 8 nodes); the reader accepts yes, no, true, false and the bare flag"),
  token("edge_connector edge_plating castellated_pads copper_finish dielectric_constraints constant djordjevic_sarkar", "extend", "X1", "stackup nodes and dielectric models"),
  token("clearance_min hole_to_hole_min through_hole_min via_min_annulus user_diff_pair creepage", "extend", "X10", "design rule values in `setup`"),
  token("fab_layers_line_width fab_layers_text_dims portrait", "not-needed", "", "KiCad's editing defaults and page orientation"),
  token("hatch_smoothing_level hatch_smoothing_value zone_type reverse_hatch cross_hatch dots squares", "extend", "X3", "hatched zone fills and copper thieving patterns"),
  token("counterbore countersink post_machining", "extend", "X22", "pad and via post-machining (KiCad 10)"),
  token("start_angle end_angle rotation_angle major_radius minor_radius fp_ellipse fp_ellipse_arc gr_ellipse gr_ellipse_arc", "extend", "X8", "ellipse and elliptical arc shapes (KiCad 11 development, a small addition to X8)"),
  token("fp_text_box line_spacing keep_upright href background ij", "extend", "X9", "footprint text boxes, line spacing, text kept upright, hyperlinks and table cell positions"),
  token("leader inward outward", "extend", "X11", "dimension kinds and arrow directions"),
  token("arrow arrow_open", "extend", "X8", "line end shapes (KiCad 10)"),
  token("linear", "report", "", "a word of KiCad's keyword list that the board writer does not use (grid or tuning, KiCad 11 development)"),
  token("private_layers", "extend", "X8", "a footprint's own layers that are not drawn on the board (KiCad 7)"),
  token("custom_property description exclude_from_sim num", "extend", "X23", "custom properties, variant descriptions, simulation flag and unit pin numbers"),
  token("lib_id", "extend", "X12", "the design block a group was made from (KiCad 10)"),
  token("affects connected_routing group_items locked_items other_items link start_end_only driving all cursor routing addsublayer", "extend", "X20", "rule area and copy-layout options (KiCad 9 and 10)"),
  token("bevelled square thru x", "extend", "X7", "pad and padstack shape words"),
  token("net_chain net_chains", "extend", "X21", "net chains for length tuning across pads and vias (KiCad 11 development)"),
  token("terminal_pad", "extend", "X21", "the pad a net chain ends on (KiCad 11 development)"),
  token("sim_electrical_type source sink", "report", "", "pad simulation roles (KiCad 11 development); this editor does no circuit simulation on the board"),
  token("grid_item polar extent spacing tick_interval", "report", "", "grid items on the board (KiCad 11 development, stamp 20260728): not released, format may change"),
  token("extruded", "report", "", "an extruded 3D body drawn from a footprint shape (KiCad 11 development, stamp 20260410): not released"),
  token("buried", "extend", "X5", "the via atom for a via between two inner layers (written from stamp 20250926, writer line 3243)"),
  token("die_delay", "extend", "X21", "pad package delay (KiCad 10), next to die_length"),
  token("module", "native", "", "the KiCad 5 spelling of footprint; the reader goes by the token in any version")
]
