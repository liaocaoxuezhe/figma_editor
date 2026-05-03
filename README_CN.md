# figma_editor

[English](README.md) · [简体中文](README_CN.md)

**在 Cursor / Claude Code / Codex 里聊设计，在 Figma 里直接出图。**

`figma_editor` 是基于 [`figsor`](https://github.com/AsifKabirAntu/figsor) 的个人 fork 与二次开发项目。它保留了 Figma 画布的编辑桥接能力，移除了 Quiver / Peer Design / design-craft-guide 等路径，并增强了组件库、变量、结构、图片与导出相关工具。

仓库地址：
[github.com/liaocaoxuezhe/figma_editor](https://github.com/liaocaoxuezhe/figma_editor)

```
Cursor / Claude Code / Codex → MCP (stdio) → figma_editor 服务 → WebSocket → Figma 插件 → 画布
```

支持同时打开多个 MCP 客户端：第一个启动的本地 MCP 进程会绑定 `FIGSOR_PORT` 并成为 WebSocket hub；之后启动的 Codex / Claude Code / Cursor 进程检测到端口被占用后,会作为 agent 代理接入同一 hub，所有发往 Figma 插件的命令由 hub 通过单条串行队列依次下发。

## 环境要求

- **Figma 桌面客户端**（网页版 Figma 无法从本地 manifest 导入未发布的插件）
- **Node.js ≥ 18**（仅当你打算从本地 checkout 运行 MCP 服务时需要；使用 `npx` 方案则会自动下载）
- 一款 MCP 客户端：**Cursor**、**Claude Code** 或 **Codex**

## 安装与配置

### 1. 克隆仓库

```bash
git clone https://github.com/liaocaoxuezhe/figma_editor.git
cd figma_editor
```

### 2.（可选）本地构建 MCP 服务

只有当你打算从本地路径运行（而不是用 `npx`）时才需要执行。

```bash
npm run setup
```

这一步会安装 `mcp-server/` 的依赖，并把 TypeScript 编译到 `mcp-server/dist/`。

### 3. 在 Figma 中安装插件

仓库中的 `figma-plugin/` 已经是构建后的产物（`code.js` + `ui.html`），可以直接导入使用：

1. 打开 **Figma 桌面客户端**，并打开任意一个设计文件。
2. 顶部菜单选择 **Plugins → Development → Import plugin from manifest…**（中文界面：**插件 → 开发 → 从 manifest 导入插件…**）。
3. 选中本仓库的 `figma-plugin/manifest.json`。
4. Figma 会在 **Plugins → Development** 列表中注册一个名为 `figma_editor` 的插件。

运行插件：**Plugins → Development → figma_editor**。Figma 内会弹出一个小面板，与 AI 对话期间请保持它处于打开状态。

### 4. 在 AI 客户端中配置 MCP 服务

Cursor、Codex、Claude Code 使用相同的 JSON 结构，仅配置文件位置不同。

推荐方式（自动使用已发布的 npm 包）：

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

如果偏好使用本地 checkout（需先完成第 2 步）：

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

各客户端的配置位置：

| 客户端 | 配置文件 |
|---|---|
| Cursor | `~/.cursor/mcp.json`（或在 **Settings → MCP → Add new global MCP server** 中添加） |
| Claude Code | `~/.claude/settings.json`（全局），或项目根目录的 `.mcp.json` |
| Codex | `~/.codex/config.toml`（`[mcp_servers.figma_editor]` 段），或 `~/.codex/mcp.json` |

保存配置后，请重启对应的 AI 客户端，使其加载新的 MCP 服务。

### 5. 连接并开始编辑

1. 在 **Figma 桌面客户端** 中打开一个设计文件。
2. 运行 **Plugins → Development → figma_editor**。
3. 在 Cursor / Claude Code / Codex 的对话窗口里发送一条消息，例如：`"使用 figma_editor 确认连接是否就绪"`。AI 会调用 `get_connection_status`，正常情况下应返回 `connected: true`。
4. 用自然语言下指令，例如：`"创建一个 1440×1024 的 frame，并在中心放置一行文字 'Hello Figma'"`。
5. 切回 Figma 即可看到画布上的实时变化。

如果你同时打开多个 AI 客户端，第一个启动的会在 `FIGSOR_PORT`（默认 `3055`）上启动 hub，其余客户端会自动以 agent 代理的方式接入。它们能安全地操作同一份 Figma 文件，因为所有插件命令都会被 hub 串行排队。

## 验证连接状态

随时可以让任意一个 AI 客户端调用内置工具：

```
请调用 get_connection_status，无需任何参数。
```

正常的返回示例：

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

- `mode: "hub"`：当前 MCP 进程占用了 WebSocket 端口，是直接与插件通信的主进程。
- `mode: "proxy"`：当前 MCP 进程作为 agent 代理接入到另一个已经运行的 hub（多客户端场景下属于正常情况）。
- `pluginConnected: false`：Figma 插件还没启动，请到 Figma 中打开插件。

## 工具速览

### 基础编辑

`create_frame`、`create_text`、`create_rectangle`、`create_ellipse`、`create_line`、`create_svg_node`、`modify_node`、`set_auto_layout`、`set_fill`、`set_stroke`、`set_effects`、`delete_node`、`move_to_parent`

### 读取与检查

`get_selection`、`get_page_structure`、`read_node_properties`、`find_nodes`、`set_selection`、`get_local_styles`、`list_components`、`create_component_instance`、`detach_instance`

### 图片、导出与动画

`set_image_fill`、`export_as_image`、`show_animation_preview`

`set_image_fill` 支持的输入：
- 本地文件路径
- Base64 字符串
- 原始字节流
- 通过 `usePluginImage: true` 让插件直接上传图片

`export_as_image` 支持 `PNG`、`JPG`、`SVG` 与 `PDF` 四种格式。

### 变量

`create_variable_collection`、`create_variable`、`bind_variable`、`get_variables`

### 组件库工作流

`scan_library`、`search_library_components`、`create_library_instance`、`get_library_info`

这些工具会使用插件设置中存放的 Figma access token 去读取组件库元数据。

### 页面与结构

`createPage`、`create_section`、`group_nodes`、`ungroup_nodes`

## 相对 figsor 移除的能力

- `quiver_generate_svg`
- `quiver_vectorize_svg`
- `get_design_craft_guide`
- `spawn_design_agent`
- `dismiss_design_agent`
- `dismiss_all_agents`

## 常见问题排查

- **`pluginConnected: false`**：Figma 插件未启动。请在 Figma 桌面客户端中打开 **Plugins → Development → figma_editor**。
- **AI 对话中报错 `Figma plugin is not connected`**：原因同上，重新打开插件后重试。
- **端口 `3055` 已被占用**：通常说明已经存在一个作为 hub 的 `figma_editor` 进程，新启动的 MCP 客户端会自动作为 proxy 接入，属于正常情况。如果确实需要一个全新的 hub，请先关闭其他 AI 客户端，或在每个客户端中把 `FIGSOR_PORT` 改成另一个端口号。
- **多客户端并发时命令变慢**：这是 hub 的串行队列在保护插件的正常表现。`get_connection_status` 返回的 `queuedCommands` 字段可以看到当前积压数量。
- **插件无法访问团队库**：在 Figma 中打开插件面板，粘贴一个 Figma personal access token；manifest 中已经申请了 `teamlibrary` 权限。

## 开源与合规

本项目基于 MIT 协议的 `figsor` 进行开发。

为保持法律和伦理上的合规，本仓库保留：
- 对上游项目与原作者的明确署名
- 衍生作品的 MIT 协议声明
- 单独的 [NOTICE.md](NOTICE.md)，记录上游来源与修改情况

需要注意：
- 本仓库目前是个人项目，没有作为商业产品运行。
- 这一陈述 **不会** 改变代码本身的协议。
- 除非某个文件特别声明，整个仓库继续遵循 MIT 协议，允许商用、修改、再分发与个人使用。

## 备注

- 插件申请了 `teamlibrary` 权限。
- 大尺寸图片在通过桥接传输前会被规整化处理，MCP 桥接发送的是 base64 而不是巨大的整数数组。
- 导出工具从原本仅支持 SVG 扩展为支持多种格式。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `FIGSOR_PORT` | `3055` | 本地 WebSocket hub 端口。希望多个客户端共用同一个 Figma 插件会话时，请保持这个端口在所有客户端中保持一致。 |

## 许可

MIT。详见 [LICENSE](LICENSE)。
