// Prints the MCP server's tools as JSON, as a fresh install lists them: without a
// token, so create_trial_database is included.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/index.js', import.meta.url).pathname, 'mcp'],
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'zektor-tools-')), ZEKTOR_TOKEN: '' },
    stderr: 'ignore',
})
const client = new Client({ name: 'bundle', version: '0' })
await client.connect(transport)
const { tools } = await client.listTools()
await client.close()

console.log(JSON.stringify(tools))
