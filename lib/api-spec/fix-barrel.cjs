// Orval uses identical names for path validators and request parameter types.
// Keep validators at the package root and group generated types in a namespace.
require("node:fs").writeFileSync("../api-zod/src/index.ts", 'export * from "./generated/api";\nexport type * as ApiTypes from "./generated/types";\n');