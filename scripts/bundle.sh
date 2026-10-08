#!/bin/sh
# Builds zektor-<version>.mcpb, the MCP server as a bundle for Claude Desktop, and
# zektor-<version>-smithery.mcpb for Smithery. The manifest's version is taken from
# package.json, so it can't drift.
#
# Smithery lists a bundle's tools from its manifest and needs each one's
# inputSchema, which the MCPB schema rejects. So its copy gets the tools as the
# server reports them, written into the archive after packing.
set -eu
cd "$(dirname "$0")/.."

npm run build
version=$(node -p "require('./package.json').version")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -R dist package.json package-lock.json LICENSE icon.png "$stage"
node -e "const m=require('./manifest.json');m.version='$version';console.log(JSON.stringify(m,null,2))" > "$stage/manifest.json"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --silent && rm package-lock.json && find dist -name '*.map' -delete)

npx -y @anthropic-ai/mcpb pack "$stage" "zektor-$version.mcpb"

manifest=$(mktemp -d)
node scripts/list-tools.mjs > "$manifest/tools.json"
node -e "const m=require('$stage/manifest.json');m.tools=require('$manifest/tools.json');delete m.tools_generated;console.log(JSON.stringify(m,null,2))" > "$manifest/manifest.json"
cp "zektor-$version.mcpb" "zektor-$version-smithery.mcpb"
(cd "$manifest" && zip -q "$OLDPWD/zektor-$version-smithery.mcpb" manifest.json)
rm -rf "$manifest"
