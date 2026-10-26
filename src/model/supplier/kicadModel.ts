// The one rule for a KiCad 3D model's name, applied by the editor when it reads an id out of a
// project and by the website's route before it fetches the file, so an id can't pass one and be
// refused by the other. Pure: the `@cherryblossom/editor/supplier` export carries it to the server.

/**
 * A model's path in KiCad's 3D repository: a `.3dshapes` directory and a STEP file in it, two
 * segments exactly, each a name of letters, digits and `_ . + - ( ) ,` that doesn't start with a
 * dot (KiCad's own names have commas: `TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal`),
 * no `..` anywhere, the extension in any case. Segments are URL-encoded when the path is sent.
 */
export const KICAD_MODEL_PATH = /^(?!.*\.\.)[A-Za-z0-9_+\-(),][A-Za-z0-9_.+\-(),]*\.3dshapes\/[A-Za-z0-9_+\-(),][A-Za-z0-9_.+\-(),]*\.(?:step|stp)$/i

/** A model's id in the parts index: the release tag and that path, `10.0.7/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step`. */
export const KICAD_MODEL_ID = /^\d+\.\d+\.\d+\/(?!.*\.\.)[A-Za-z0-9_+\-(),][A-Za-z0-9_.+\-(),]*\.3dshapes\/[A-Za-z0-9_+\-(),][A-Za-z0-9_.+\-(),]*\.(?:step|stp)$/i
