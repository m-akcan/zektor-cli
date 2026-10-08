#!/bin/sh
# Builds zektor-<version>.mcpb: the MCP server as a bundle for Smithery and Claude
# Desktop. The manifest's version is taken from package.json, so it can't drift.
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
