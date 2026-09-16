# MCP Server — Quick Reference

```bash
# Run
uv run valaris-mcp

# Test
uv run --extra dev pytest tests/ -v

# Lint
ruff check src/
ruff format src/
```

## Adding a New Tool

1. Create or extend a module in `src/valaris_mcp/tools/`.
2. Decorate with `@mcp.tool()`, then `@handle_api_errors` below it.
3. Last parameter: `ctx: Context = None`.
4. Return `json.dumps(result, indent=2, default=str)`.
5. Include `_hint` field in response for agentic guidance.
6. Register the module import in `server.py`.
7. Add a `TOOL_META` entry in `catalog.py` (category/kind/destructive/idempotent) and a `ToolDoc` in the frontend (`frontend/src/pages/documentation/mcp-reference/data/`), then regenerate fixtures with `scripts/export-tool-catalog.py`. The category you pick decides which toolsets carry the tool (`toolsets.py`: its category id and that category's group id); a tool in a default group is in the interactive default hand unless listed in `DEFAULT_EXCLUSIONS`; a read-only tool outside those groups joins it only via `DEFAULT_INCLUSIONS`. The `server-info` category rides on every hand, and a present `VALARIS_MCP_ALLOWLIST` with no toolsets env loads every toolset (runner compatibility). The hand is a mutable `HandState` on `AppContext`, read by the list filter and the call gate; `enable_toolsets` widens it at runtime (widen-only, the allowlist is a ceiling it never lifts).
8. Add tests in `tests/test_tools.py`.

## Retiring or Renaming a Tool

1. Register the old name through `valaris_mcp.deprecation.deprecated_tool()` (not `@mcp.tool()`) and set `deprecated_for="<replacement call>"` on its `TOOL_META` entry — the catalog seam refuses a mismatch. The alias keeps working, logs per call, stamps `_deprecated` on results, is listed with `_meta.deprecated`, and belongs to no toolset.
2. Remove the old name from the frontend `toolCatalog.ts` and its `ToolDoc`; the reference lists aliases from `server-surface.json`'s `deprecated` map. Drop it from `DEFAULT_EXCLUSIONS`/`DEFAULT_INCLUSIONS`, server instructions, prompts, catalog skills, and loop templates (bump their versions).
3. Regenerate the fixtures (`scripts/export-tool-catalog.py`) and add the rename to the CHANGELOG upgrade table.
4. Delete every alias registered before `DEPRECATION_REMOVAL_VERSION` when that version ships, then bump the constant.

