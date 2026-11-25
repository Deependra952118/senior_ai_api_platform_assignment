.PHONY: install run test test-postman lint-spec demo demo-offline evals token mcp-config clean

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

install: node_modules

## API on :3000 with the mock upstreams embedded on :4010
run: node_modules
	npm start

test: node_modules
	npm test

## Needs `make run` in another terminal
test-postman: node_modules
	npm run test:postman

lint-spec: node_modules
	npm run lint:spec

## LLM demo; needs `make run` and ANTHROPIC_API_KEY
demo: node_modules
	npm run -s demo

## Same tool calls without an LLM
demo-offline: node_modules
	npm run -s demo:offline

evals: node_modules
	npm run -s evals

## make token P=support-lead
token: node_modules
	@node scripts/token.js $(or $(P),copilot)

## Prints a Claude Desktop / Cursor MCP config for this checkout (token valid 8h)
mcp-config: node_modules
	@node scripts/mcp-config.js

clean:
	rm -rf var mcp/audit.log mcp/evals/results postman/environment.local.json
