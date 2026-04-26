# figma_editor MCP Server

The `mcp-server` package powers the `figma_editor` MCP server used by the Figma plugin bridge.

Upstream origin:
[github.com/AsifKabirAntu/figsor](https://github.com/AsifKabirAntu/figsor)

Fork maintainer:
[github.com/liaocaoxuezhe](https://github.com/liaocaoxuezhe)

## Main capabilities

- Canvas creation and editing
- Auto-layout, fills, strokes, and effects
- Local component and library workflows
- Variable creation and binding
- Image-fill bridging from local files, base64, bytes, and plugin uploads
- Multi-format export with `export_as_image`
- Page / section / group structure tools

## Added tools

- `scan_library`
- `search_library_components`
- `create_library_instance`
- `get_library_info`
- `create_variable_collection`
- `create_variable`
- `bind_variable`
- `get_variables`
- `createPage`
- `create_section`
- `group_nodes`
- `ungroup_nodes`

## Removed tools

- `quiver_generate_svg`
- `quiver_vectorize_svg`
- `get_design_craft_guide`
- `spawn_design_agent`
- `dismiss_design_agent`
- `dismiss_all_agents`

## License and attribution

This package is part of a derivative MIT-licensed project based on `figsor`.

- Upstream attribution is preserved.
- MIT notice is retained.
- Repository-level attribution details are documented in `../NOTICE.md`.

## Usage

```json
{
  "mcpServers": {
    "figma_editor": {
      "command": "npx",
      "args": ["-y", "figma_editor"]
    }
  }
}
```
