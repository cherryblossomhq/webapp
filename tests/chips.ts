import { buildCustomPart } from "../src/model/customParts"
import { registerPart } from "../src/model/library"
import RETIRED from "../src/model/migrations/libraryParts.json"
import type { CustomPartSpec } from "../src/model/types"

// The chips and modules the library listed until it held basic parts only (`migrations/libraryParts.ts`),
// registered for every test under the ids it gave them ("ne555", "atmega328p", "esp32_devkit_v1"), so
// a test can place a familiar chip without making one. A project file read in a test still has them
// renamed to its own parts by the migration, as the editor does.

for (const [id, spec] of Object.entries(RETIRED as Record<string, CustomPartSpec>)) registerPart(buildCustomPart({ ...spec, id }))
