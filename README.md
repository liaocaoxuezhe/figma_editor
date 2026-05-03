# figma_editor

[English](README.md) · [简体中文](README_CN.md)

**Chat in Cursor/Claude Code/Codex. Edit in Figma.**

`figma_editor` is a personal fork and secondary-development project based on [`figsor`](https://github.com/AsifKabirAntu/figsor). It keeps the Figma canvas editing bridge, removes the Quiver / Peer Design / design-craft-guide paths, and adds stronger library, variable, structure, image, and export tooling.

Repository:
[github.com/liaocaoxuezhe/figma_editor](https://github.com/liaocaoxuezhe/figma_editor)

```
Cursor/Claude Code/Codex → MCP (stdio) → figma_editor server → WebSocket → Figma plugin → Design on Canvas
```

Multiple MCP clients can be open at the same time. The first local MCP process becomes the WebSocket hub on `FIGSOR_PORT`; later Codex / Claude Code / Cursor processes detect the occupied port, join that hub as agent proxies, and the hub sends all Figma plugin commands through a single serial queue.

## Requirements

- **Figma Desktop App** (the in-browser editor cannot import unpublished plugins from a manifest)
- **Node.js ≥ 18** (only required if you want to run the MCP server from a local checkout; the `npx` flow downloads everything for you)
- One MCP-aware client: **Cursor**, **Claude Code**, or **Codex**

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/liaocaoxuezhe/figma_editor.git
cd figma_editor
```

### 2. (Optional) Build the MCP server locally

You only need this if you plan to run the server from a local path instead of `npx`.

```bash
npm run setup
```

This installs dependencies in `mcp-server/` and compiles TypeScript into `mcp-server/dist/`.

### 3. Install the Figma plugin

The plugin under `figma-plugin/` is already pre-built (`code.js` + `ui.html`), so you can import it directly:

1. Open the **Figma Desktop App** and any design file.
2. From the top menu choose **Plugins → Development → Import plugin from manifest…**.
3. Select `figma-plugin/manifest.json` from this repository.
4. Figma will register a plugin called `figma_editor` under **Plugins → Development**.

To run the plugin: **Plugins → Development → figma_editor**. A small panel will open inside Figma — keep it open while you chat with the AI client.

### 4. Add the MCP server to your AI client

Cursor, Codex, and Claude Code all share the same JSON shape; only the file location differs.

Recommended (uses the published npm package automatically):

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

If you prefer running the local checkout (after step 2):

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

Where to put it:

| Client | Config file |
|---|---|
| Cursor | `~/.cursor/mcp.json` (or **Settings → MCP → Add new global MCP server**) |
| Claude Code | `~/.claude/settings.json` (global) or `.mcp.json` in your project root |
| Codex | `~/.codex/config.toml` (`[mcp_servers.figma_editor]` section) or `~/.codex/mcp.json` |

After saving the config, restart your AI client so it picks up the new MCP server.

### 5. Connect and start editing

1. Open a Figma file in the **desktop app**.
2. Run **Plugins → Development → figma_editor**.
3. Open a chat in Cursor / Claude Code / Codex and send a message such as `"Use figma_editor to confirm the connection."` — the assistant should be able to call `get_connection_status` and report `connected: true`.
4. Ask in plain language: `"Create a 1440×1024 frame and add a centered headline that reads 'Hello Figma'."`
5. Watch the change land on the Figma canvas.

If multiple AI clients are open, the first one starts a hub on `FIGSOR_PORT` (default `3055`); the rest auto-attach as agent proxies. They all drive the same Figma file safely because plugin commands are queued serially by the hub.

## Verify the connection

You can ask any of the supported AI clients to call the built-in MCP tool:

```
Please call get_connection_status with no arguments.
```

A healthy response looks like:

```json
{
  "mode": "hub",
  "connected": true,
  "pluginConnected": true,
  "agentProxyCount": 0,
  "queuedCommands": 0,
  "peerDesign": { ... }
}
```

- `mode: "hub"` — this MCP process owns the WebSocket port and talks to the plugin directly.
- `mode: "proxy"` — this MCP process attached to another running hub (expected when you launch a second client).
- `pluginConnected: false` — the Figma plugin is not running yet; open the plugin in Figma.

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

## Troubleshooting

- **`pluginConnected: false`** — the Figma plugin is not running. In Figma desktop, open **Plugins → Development → figma_editor**.
- **`Figma plugin is not connected`** error inside the AI chat — same cause as above; re-open the plugin and retry the request.
- **Port `3055` already in use** — another `figma_editor` process is already serving as the hub. New MCP clients automatically attach as proxies, which is expected. If you really want a fresh hub, close other AI clients first or set `FIGSOR_PORT` to a different number in every client.
- **Commands feel slow when several clients are open** — that is the serial command queue protecting the plugin. `get_connection_status` reports `queuedCommands` so you can see how deep the backlog is.
- **Plugin can't reach a team library** — open the plugin panel in Figma and paste a Figma personal access token; the `teamlibrary` permission is requested in the manifest.

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
| `FIGSOR_PORT` | `3055` | Local WebSocket hub port. Keep this the same across clients that should share one Figma plugin session. |

## License

MIT. See [LICENSE](LICENSE).
