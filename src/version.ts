import { createRequire } from 'node:module'

/**
 * The package version, read from `package.json` rather than repeated.
 *
 * It is reported in three places — `zektor --version`, the MCP handshake, and
 * npm — and a literal in each is three chances to forget one. `createRequire`
 * because a JSON import assertion is still awkward under NodeNext, and the path
 * resolves the same from `src/` and `dist/`.
 */
const require = createRequire(import.meta.url)

export const VERSION: string = (require('../package.json') as { version: string }).version
