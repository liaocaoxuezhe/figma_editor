# figma_editor

**Chat in Cursor/Claude Code/Codex. Edit in Figma.**

`figma_editor` is a personal fork and secondary-development project based on [`figsor`](https://github.com/AsifKabirAntu/figsor). It keeps the Figma canvas editing bridge, removes the Quiver / Peer Design / design-craft-guide paths, and adds stronger library, variable, structure, image, and export tooling.

Repository:
[github.com/liaocaoxuezhe/figma_editor](https://github.com/liaocaoxuezhe/figma_editor)

```
Cursor/Claude Code/Codex → MCP (stdio) → figma_editor server → WebSocket → Figma plugin → Design on Canvas
```

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/liaocaoxuezhe/figma_editor.git
cd figma_editor
```

### 2. Install the Figma plugin

In Figma: **Plugins → Development → Import plugin from manifest** → select `figma-plugin/manifest.json`

### 3. Add to your MCP client

Cursor / Codex / Claude Code can all use the same MCP config:

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

If you prefer running from the local checkout during development:

```json
{
  "mcpServers": {
    "figma_editor": {
      "command": "node",
      "args": ["/absolute/path/to/figma_editor/mcp-server/dist/server.js"]
    }
  }
}
```

### 4. Start editing

1. Open a Figma file
2. Run the `figma_editor` plugin
3. Chat in Cursor / Claude Code / Codex

## Tool Highlights

### Core editing

`create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, `create_line`, `create_svg_node`, `modify_node`, `set_auto_layout`, `set_fill`, `set_stroke`, `set_effects`, `delete_node`, `move_to_parent`

### Read and inspect

`get_selection`, `get_page_structure`, `read_node_properties`, `find_nodes`, `set_selection`, `get_local_styles`, `list_components`, `create_component_instance`, `detach_instance`

### Image, export, and animation

`set_image_fill`, `export_as_image`, `show_animation_preview`

`set_image_fill` supports:
- Local file path
- Base64 payload
- Raw bytes
- Plugin-uploaded image bridge via `usePluginImage: true`

`export_as_image` supports `PNG`, `JPG`, `SVG`, and `PDF`.

### Variables

`create_variable_collection`, `create_variable`, `bind_variable`, `get_variables`

### Library workflow

`scan_library`, `search_library_components`, `create_library_instance`, `get_library_info`

These use the Figma access token stored in the plugin settings to read library metadata.

### Page and structure

`createPage`, `create_section`, `group_nodes`, `ungroup_nodes`

## Removed From figsor

- `quiver_generate_svg`
- `quiver_vectorize_svg`
- `get_design_craft_guide`
- `spawn_design_agent`
- `dismiss_design_agent`
- `dismiss_all_agents`

## Open Source And Compliance

This project is based on `figsor`, which is MIT-licensed.

To stay legally and ethically compliant, this repository keeps:
- Clear attribution to the upstream project and original author
- MIT license notice for the derivative work
- A separate [NOTICE.md](NOTICE.md) describing upstream origin and modification status

Important:
- This is currently a personal project and is not being run as a commercial product.
- That statement does **not** change the code license.
- Unless a file says otherwise, this repository remains under the MIT License, which permits commercial use, modification, distribution, and private use.

## Notes

- The plugin requests the `teamlibrary` permission.
- Large images are normalized before bridge transfer, and the MCP bridge sends base64 instead of huge integer arrays.
- The export tool is generalized from SVG-only export to multi-format export.

## Configuration

| Environment Variable | Default | Description |
|---|---:|---|
| `FIGSOR_PORT` | `3055` | WebSocket server port |

## License

MIT. See [LICENSE](LICENSE).
