#!/usr/bin/env node
/**
 * figma_editor — Figma ↔ MCP Client Server
 *
 * This server does two things:
 * 1. Runs an MCP server (over stdio) so Codex/Claude Code/Cursor can call design tools
 * 2. Runs a WebSocket server so the Figma plugin can connect and receive commands
 *
 * Flow: MCP client → MCP tool call → queued WebSocket bridge → Figma plugin → design created
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { randomUUID, createHmac, randomBytes } from "crypto";
import { readFile } from "fs/promises";

// ─── Logging (stderr only — stdout is reserved for MCP protocol) ────────────

const log = (...args: unknown[]) =>
  console.error(`[figma_editor ${new Date().toISOString()}]`, ...args);

// ─── Configuration ──────────────────────────────────────────────────────────

const WS_PORT = Number(process.env.FIGSOR_PORT) || 3055;
const COMMAND_TIMEOUT_MS = 30_000;
const FIGMA_API_BASE = "https://api.figma.com/v1";

interface PluginContext {
  token?: string | null;
  imageBase64?: string | null;
  imageName?: string | null;
  imageMimeType?: string | null;
}

interface LibraryScanCache {
  fileKey: string;
  fileName: string;
  editorType?: string;
  lastScannedAt: string;
  componentSets: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
  styles: Array<Record<string, unknown>>;
}

// ─── Handshake Secret (obfuscated) ──────────────────────────────────────────
// This key is split and reassembled at runtime to deter casual inspection.
const _a = "fgsr"; const _b = "7x9K"; const _c = "mQ3p"; const _d = "Wv2R";
const _e = "nL8j"; const _f = "Ht5Y"; const _g = "cD4s"; const _h = "bA6e";
const HANDSHAKE_KEY = [_a, _b, _c, _d, _e, _f, _g, _h].join("");

// ─── WebSocket Bridge ───────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface BridgeStatus {
  mode: "hub" | "proxy";
  connected: boolean;
  pluginConnected: boolean;
  agentProxyCount: number;
  queuedCommands: number;
}

class FigmaEditorBridge {
  private pluginWs: WebSocket | null = null;
  private agentWs: WebSocket | null = null;
  private agentSockets = new Set<WebSocket>();
  private pendingRequests = new Map<string, PendingRequest>();
  private wss: WebSocketServer | null = null;
  private mode: "hub" | "proxy" = "hub";
  private ready: Promise<void>;
  private commandQueue: Promise<void> = Promise.resolve();
  private queuedCommands = 0;

  constructor(port: number) {
    this.ready = this.start(port);
  }

  private async start(port: number) {
    try {
      const wss = new WebSocketServer({ port });
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          wss.off("error", onError);
          resolve();
        };
        const onError = (error: Error & { code?: string }) => {
          wss.off("listening", onListening);
          reject(error);
        };
        wss.once("listening", onListening);
        wss.once("error", onError);
      });

      this.wss = wss;
      this.mode = "hub";
      this.attachHubHandlers(wss);
      log(`WebSocket hub listening on port ${port}`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EADDRINUSE") {
        throw error;
      }

      this.mode = "proxy";
      log(`WebSocket port ${port} is already in use; joining existing figma_editor hub as an agent proxy`);
      await this.connectAgentProxy(port);
    }
  }

  private attachHubHandlers(wss: WebSocketServer) {
    wss.on("connection", (ws) => {
      log("New WebSocket connection — starting handshake...");

      // Generate a random nonce for this connection
      const nonce = randomBytes(32).toString("hex");
      let handshakeComplete = false;
      let role: "plugin" | "agent" | null = null;

      // Send nonce challenge
      ws.send(JSON.stringify({ type: "handshake_challenge", nonce }));

      // Set a handshake timeout — must authenticate within 5s
      const handshakeTimeout = setTimeout(() => {
        if (!handshakeComplete) {
          log("Handshake timeout — closing connection");
          ws.close(4001, "Handshake timeout");
        }
      }, 5000);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // ── Handshake verification ──
          if (!handshakeComplete) {
            if (msg.type === "handshake_response" && msg.hash) {
              const expected = createHmac("sha256", HANDSHAKE_KEY)
                .update(nonce)
                .digest("hex");
              if (msg.hash === expected) {
                handshakeComplete = true;
                role = msg.role === "agent" ? "agent" : "plugin";
                clearTimeout(handshakeTimeout);

                if (role === "agent") {
                  this.agentSockets.add(ws);
                  ws.send(JSON.stringify({ type: "handshake_ok", role }));
                  log(`Agent proxy authenticated ✓ (${this.agentSockets.size} connected)`);
                  return;
                }

                // Close any previous Figma plugin connection. Agent proxy
                // connections stay open and keep sharing the same hub.
                if (this.pluginWs && this.pluginWs !== ws && this.pluginWs.readyState === WebSocket.OPEN) {
                  this.pluginWs.close();
                }
                this.pluginWs = ws;

                ws.send(JSON.stringify({ type: "handshake_ok", role }));
                log("Figma plugin authenticated ✓");
              } else {
                log("Handshake failed — invalid hash");
                ws.close(4003, "Invalid handshake");
              }
            } else {
              // Not a handshake message before auth — reject
              ws.send(JSON.stringify({ type: "error", error: "Handshake required" }));
            }
            return;
          }

          // ── Authenticated messages ──

          if (role === "agent") {
            if (msg.type === "agent_status" && msg.id) {
              ws.send(JSON.stringify({ type: "agent_response", id: msg.id, result: this.status }));
              return;
            }

            if (msg.type !== "agent_command" || !msg.id || !msg.command) {
              ws.send(JSON.stringify({ type: "agent_error", id: msg.id, error: "Invalid agent command" }));
              return;
            }

            this.enqueuePluginCommand(msg.command, msg.params || {})
              .then((result) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "agent_response", id: msg.id, result }));
                }
              })
              .catch((error: unknown) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "agent_error",
                    id: msg.id,
                    error: error instanceof Error ? error.message : String(error),
                  }));
                }
              });
            return;
          }

          // Handle peer design settings from plugin UI
          if (msg.type === "settings_update") {
            if (msg.peerDesign !== undefined) {
              peerDesignSettings = {
                enabled: !!msg.peerDesign,
                agentCount: msg.agentCount || peerDesignSettings.agentCount,
              };
              log(`Peer design: ${peerDesignSettings.enabled ? "ON" : "OFF"}, ${peerDesignSettings.agentCount} agents`);
            }
            return;
          }

          // Handle image upload/removal notifications from plugin UI
          if (msg.type === "image_uploaded") {
            uploadedImageInfo = {
              name: msg.name || "uploaded-image",
              size: msg.size || 0,
              mimeType: msg.mimeType || "image/png",
              available: true,
            };
            log(`Image uploaded in plugin: ${uploadedImageInfo.name} (${uploadedImageInfo.size} bytes)`);
            return;
          }
          if (msg.type === "image_removed") {
            uploadedImageInfo = { name: null, size: 0, mimeType: null, available: false };
            log("Image removed from plugin");
            return;
          }

          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(msg.id);
            if (msg.type === "error") {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          log("Error parsing WebSocket message:", e);
        }
      });

      ws.on("close", () => {
        clearTimeout(handshakeTimeout);
        if (role === "agent") {
          this.agentSockets.delete(ws);
          log(`Agent proxy disconnected (${this.agentSockets.size} connected)`);
          return;
        }

        if (this.pluginWs === ws) {
          log("Figma plugin disconnected");
          this.pluginWs = null;
          // Reject all pending requests
          for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Figma plugin disconnected"));
          }
          this.pendingRequests.clear();
        }
      });

      ws.on("error", (err) => {
        log("WebSocket error:", err.message);
      });
    });
  }

  private async connectAgentProxy(port: number) {
    const url = `ws://localhost:${port}`;
    this.agentWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to figma_editor hub at ${url}`));
      }, 5000);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "handshake_challenge" && msg.nonce) {
            const hash = createHmac("sha256", HANDSHAKE_KEY)
              .update(msg.nonce)
              .digest("hex");
            ws.send(JSON.stringify({ type: "handshake_response", hash, role: "agent" }));
            return;
          }

          if (msg.type === "handshake_ok") {
            clearTimeout(timeout);
            this.attachProxyMessageHandlers(ws);
            log("Connected to existing figma_editor hub as an agent proxy ✓");
            resolve(ws);
            return;
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private attachProxyMessageHandlers(ws: WebSocket) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);
        if (msg.type === "agent_error") {
          pending.reject(new Error(msg.error));
        } else if (msg.type === "agent_response") {
          pending.resolve(msg.result);
        }
      } catch (error) {
        log("Error parsing proxy WebSocket message:", error);
      }
    });

    ws.on("close", () => {
      log("Disconnected from figma_editor hub");
      this.agentWs = null;
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Disconnected from figma_editor hub"));
      }
      this.pendingRequests.clear();
    });

    ws.on("error", (error) => {
      log("Agent proxy WebSocket error:", error.message);
    });
  }

  get isConnected(): boolean {
    if (this.mode === "proxy") {
      return this.agentWs !== null && this.agentWs.readyState === WebSocket.OPEN;
    }
    return this.pluginWs !== null && this.pluginWs.readyState === WebSocket.OPEN;
  }

  get status(): BridgeStatus {
    return {
      mode: this.mode,
      connected: this.isConnected,
      pluginConnected: this.pluginWs !== null && this.pluginWs.readyState === WebSocket.OPEN,
      agentProxyCount: this.agentSockets.size,
      queuedCommands: this.queuedCommands,
    };
  }

  async getStatus(): Promise<BridgeStatus> {
    await this.ready;
    if (this.mode === "proxy") {
      return await this.sendStatusToHub() as BridgeStatus;
    }
    return this.status;
  }

  async sendCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    if (this.mode === "proxy") {
      return this.sendCommandToHub(command, params);
    }
    return this.enqueuePluginCommand(command, params);
  }

  private enqueuePluginCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
    this.queuedCommands++;
    const queuedPosition = this.queuedCommands;
    if (queuedPosition > 1) {
      log(`Queued command '${command}' behind ${queuedPosition - 1} command(s)`);
    }

    const task = async () => {
      this.queuedCommands--;
      return this.sendCommandToPlugin(command, params);
    };

    const result = this.commandQueue.then(task, task);
    this.commandQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async sendCommandToPlugin(command: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.pluginWs || this.pluginWs.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Figma plugin is not connected. Please open Figma and run the figma_editor plugin first."
      );
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command '${command}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.pluginWs!.send(JSON.stringify({ id, command, params }));
    });
  }

  private sendCommandToHub(command: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.agentWs || this.agentWs.readyState !== WebSocket.OPEN) {
      throw new Error(
        "figma_editor hub is not connected. Start one MCP client first, then run the Figma plugin."
      );
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command '${command}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.agentWs!.send(JSON.stringify({ type: "agent_command", id, command, params }));
    });
  }

  private sendStatusToHub(): Promise<unknown> {
    if (!this.agentWs || this.agentWs.readyState !== WebSocket.OPEN) {
      return Promise.resolve(this.status);
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Status request timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.agentWs!.send(JSON.stringify({ type: "agent_status", id }));
    });
  }
}

// ─── Create instances ───────────────────────────────────────────────────────

const bridge = new FigmaEditorBridge(WS_PORT);

// ─── Peer Design State ──────────────────────────────────────────────────────

let peerDesignSettings = { enabled: false, agentCount: 3 };
let uploadedImageInfo: { name: string | null; size: number; mimeType: string | null; available: boolean } = {
  name: null, size: 0, mimeType: null, available: false,
};
const libraryScanCache = new Map<string, LibraryScanCache>();

const server = new McpServer(
  {
    name: "figma_editor",
    version: "1.0.0",
  },
  {
    instructions: `You are figma_editor, a Figma editing MCP server.

Favor existing components, variables, auto-layout, and clear structure. Use transparent container fills unless a background is intentional, avoid hard-coded positioning when layout tools are more appropriate, and preserve the user's current design system when one exists.`,
  }
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function err(error: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error}` }],
    isError: true,
  };
}

function parseFigmaFileKey(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/figma\.com\/(?:design|file|board|slides)\/([^/?#]+)/i);
  return match ? match[1] : trimmed;
}

function parseFigmaNodeId(input?: string) {
  return input ? input.replace(/-/g, ":") : input;
}

function bytesToBase64(bytes: Uint8Array | Buffer) {
  return Buffer.from(bytes).toString("base64");
}

async function getPluginContext(): Promise<PluginContext> {
  return await bridge.sendCommand("get_plugin_context", {}) as PluginContext;
}

async function getFigmaToken() {
  const ctx = await getPluginContext();
  if (!ctx.token) {
    throw new Error("Figma access token not configured in the plugin. Open the plugin Settings and paste a token with file/library read scopes.");
  }
  return ctx.token;
}

async function figmaApiGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${FIGMA_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await res.json() as Record<string, unknown>;
    } catch {
      payload = null;
    }
    const details = payload?.message || payload?.err || res.statusText;
    throw new Error(`Figma API error [${res.status}]: ${details}`);
  }

  return await res.json() as T;
}

function normalizeLibraryComponent(item: Record<string, unknown>) {
  return {
    key: item.key,
    fileKey: item.file_key,
    nodeId: item.node_id,
    name: item.name,
    description: item.description || "",
    thumbnailUrl: item.thumbnail_url,
    updatedAt: item.updated_at,
    createdAt: item.created_at,
    containingFrame: item.containing_frame || null,
  };
}

async function scanLibraryFile(fileOrUrl: string) {
  const token = await getFigmaToken();
  const fileKey = parseFigmaFileKey(fileOrUrl);

  const [file, componentSetsResponse] = await Promise.all([
    figmaApiGet<Record<string, unknown>>(token, `/files/${fileKey}`),
    figmaApiGet<Record<string, unknown>>(token, `/files/${fileKey}/component_sets`),
  ]);

  const componentsMap = (file.components || {}) as Record<string, Record<string, unknown>>;
  const stylesMap = (file.styles || {}) as Record<string, Record<string, unknown>>;
  const componentSets = ((componentSetsResponse.meta as Record<string, unknown>)?.component_sets || []) as Array<Record<string, unknown>>;

  const scan: LibraryScanCache = {
    fileKey,
    fileName: String(file.name || fileKey),
    editorType: typeof file.editorType === "string" ? file.editorType : undefined,
    lastScannedAt: new Date().toISOString(),
    componentSets: componentSets.map(normalizeLibraryComponent),
    components: Object.values(componentsMap).map(normalizeLibraryComponent),
    styles: Object.values(stylesMap).map((style) => ({
      key: style.key,
      fileKey: style.file_key,
      nodeId: style.node_id,
      name: style.name,
      description: style.description || "",
      styleType: style.style_type || style.styleType || null,
      thumbnailUrl: style.thumbnail_url || null,
    })),
  };

  libraryScanCache.set(fileKey, scan);
  return scan;
}

async function run(command: string, params: Record<string, unknown>) {
  try {
    const result = await bridge.sendCommand(command, params);
    return ok(result);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─── MCP Tools ──────────────────────────────────────────────────────────────

// 1. Connection status
server.tool(
  "get_connection_status",
  "Check whether the Figma plugin is connected.",
  {},
  async () => ok({ ...(await bridge.getStatus()), peerDesign: peerDesignSettings })
);

// 2. Create Frame
server.tool(
  "create_frame",
  `Create a new frame in Figma. Frames are the primary container/layout element (like a div in HTML). Use them for screens, sections, cards, navigation bars, buttons, etc. Returns the new frame's node ID for use in subsequent operations.

BEST PRACTICE: Always follow up with set_auto_layout on container frames. Use padding/spacing instead of hardcoded x/y. Omit fillColor on layout-only frames (they should be transparent). Only set fillColor on frames that genuinely need a background (cards, screens, buttons).`,
  {
    name: z.string().optional().describe("Name of the frame (e.g. 'Login Screen', 'Nav Bar')"),
    x: z.number().optional().describe("X position in pixels (default: 0)"),
    y: z.number().optional().describe("Y position in pixels (default: 0)"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z
      .string()
      .optional()
      .describe("Fill color as hex string e.g. '#FFFFFF', '#1A1A2E', '#FF000080' (with alpha)"),
    cornerRadius: z.number().optional().describe("Corner radius in pixels"),
    parentId: z
      .string()
      .optional()
      .describe("ID of a parent frame to nest this inside. Omit to place on the canvas root."),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_frame", params)
);

server.tool(
  "createPage",
  "Create a new page in the current Figma file and optionally switch to it.",
  {
    name: z.string().optional().describe("Page name."),
    switchToPage: z.boolean().optional().describe("Whether to switch the viewport to the new page. Defaults to true."),
  },
  async (params) => run("createPage", params)
);

server.tool(
  "create_section",
  "Create a section on the current page or inside a page-level parent.",
  {
    name: z.string().optional().describe("Section name."),
    x: z.number().optional().describe("X position."),
    y: z.number().optional().describe("Y position."),
    width: z.number().optional().describe("Width in pixels."),
    height: z.number().optional().describe("Height in pixels."),
    parentId: z.string().optional().describe("Optional parent node id."),
    agentId: z.string().optional().describe("Optional agent id."),
  },
  async (params) => run("create_section", params)
);

server.tool(
  "group_nodes",
  "Group nodes under a single Figma group.",
  {
    nodeIds: z.array(z.string()).describe("Node ids to group."),
    parentId: z.string().optional().describe("Optional target parent for the group."),
    index: z.number().optional().describe("Optional insertion index."),
    name: z.string().optional().describe("Optional group name."),
  },
  async (params) => run("group_nodes", params)
);

server.tool(
  "ungroup_nodes",
  "Ungroup a Figma group and return the child node ids.",
  {
    nodeId: z.string().describe("Group node id."),
  },
  async (params) => run("ungroup_nodes", params)
);

// 3. Create Rectangle
server.tool(
  "create_rectangle",
  "Create a rectangle shape. Useful for backgrounds, dividers, decorative elements, image placeholders, etc.",
  {
    name: z.string().optional().describe("Name of the rectangle"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z.string().optional().describe("Fill color as hex e.g. '#E2E8F0'"),
    cornerRadius: z.number().optional().describe("Corner radius"),
    parentId: z.string().optional().describe("Parent frame ID to place inside"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_rectangle", params)
);

// 4. Create Ellipse
server.tool(
  "create_ellipse",
  "Create an ellipse (circle or oval). Useful for avatars, status indicators, decorative elements. Set equal width/height for a perfect circle.",
  {
    name: z.string().optional().describe("Name of the ellipse"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width in pixels (default: 100)"),
    height: z.number().optional().describe("Height in pixels (default: 100)"),
    fillColor: z.string().optional().describe("Fill color as hex"),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_ellipse", params)
);

// 5. Create Text
server.tool(
  "create_text",
  `Create a text element. Supports font family, size, weight (via fontStyle), color, and text wrapping.

TYPOGRAPHY RULES: Set letterSpacing on ALL CAPS text (3-5px for 12-14px font), small text 11-13px (0.2-0.5px), and tighten large headings 32px+ (-0.3 to -0.5px). Use lineHeight: body 1.5-1.7× fontSize, headlines 1.0-1.2×. Never use pure #000000 — use #0B0B0B or #111111 instead.`,
  {
    text: z.string().describe("The text content to display"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    fontSize: z.number().optional().describe("Font size in pixels (default: 14)"),
    fontFamily: z
      .string()
      .optional()
      .describe("Font family name (default: 'Inter'). Must be available in the Figma file."),
    fontStyle: z
      .string()
      .optional()
      .describe(
        "Font style e.g. 'Regular', 'Bold', 'Semi Bold', 'Medium', 'Light' (default: 'Regular')"
      ),
    fillColor: z.string().optional().describe("Text color as hex e.g. '#1A1A2E'"),
    width: z
      .number()
      .optional()
      .describe("Fixed width for text wrapping. Omit for auto-width."),
    letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
    lineHeight: z.number().optional().describe("Line height in pixels"),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional()
      .describe("Horizontal text alignment"),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_text", params)
);

// 6. Create Line
server.tool(
  "create_line",
  "Create a line element. Useful for dividers, separators, and decorative lines.",
  {
    name: z.string().optional().describe("Name of the line"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    length: z.number().optional().describe("Length of the line in pixels (default: 100)"),
    color: z.string().optional().describe("Line color as hex (default: '#000000')"),
    strokeWeight: z.number().optional().describe("Line thickness in pixels (default: 1)"),
    rotation: z.number().optional().describe("Rotation in degrees (0 = horizontal, 90 = vertical)"),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_line", params)
);

// 7. Create SVG Node
server.tool(
  "create_svg_node",
  "Create a node from an SVG string. Great for icons, logos, and vector illustrations.",
  {
    svg: z.string().describe("Valid SVG markup string"),
    name: z.string().optional().describe("Name for the created node"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Scale to this width"),
    height: z.number().optional().describe("Scale to this height"),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_svg_node", params)
);

// 8. Set Auto Layout
server.tool(
  "set_auto_layout",
  `Configure auto-layout on a frame (Figma's equivalent of CSS Flexbox). This controls how children are arranged and spaced within the frame. Set direction, spacing, padding, and alignment.`,
  {
    nodeId: z.string().describe("ID of the frame to configure"),
    direction: z
      .enum(["HORIZONTAL", "VERTICAL"])
      .optional()
      .describe("Layout direction — HORIZONTAL (row) or VERTICAL (column). Default: VERTICAL"),
    spacing: z.number().optional().describe("Gap between child items in pixels"),
    padding: z
      .number()
      .optional()
      .describe("Uniform padding on all sides (shorthand). Overrides individual paddings."),
    paddingTop: z.number().optional().describe("Top padding"),
    paddingRight: z.number().optional().describe("Right padding"),
    paddingBottom: z.number().optional().describe("Bottom padding"),
    paddingLeft: z.number().optional().describe("Left padding"),
    primaryAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"])
      .optional()
      .describe("Alignment along the main axis (like justify-content)"),
    counterAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX"])
      .optional()
      .describe("Alignment along the cross axis (like align-items)"),
    primaryAxisSizingMode: z
      .enum(["FIXED", "AUTO"])
      .optional()
      .describe("FIXED = fixed size along main axis, AUTO = hug contents"),
    counterAxisSizingMode: z
      .enum(["FIXED", "AUTO"])
      .optional()
      .describe("FIXED = fixed size along cross axis, AUTO = hug contents"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("set_auto_layout", params)
);

// 9. Modify Node
server.tool(
  "modify_node",
  `Modify properties of an existing node. Works on any node type. For text nodes, you can also update characters and fontSize. For auto-layout children, you can set layoutSizingHorizontal/layoutSizingVertical to control how they fill space.`,
  {
    nodeId: z.string().describe("ID of the node to modify"),
    x: z.number().optional().describe("New X position"),
    y: z.number().optional().describe("New Y position"),
    width: z.number().optional().describe("New width"),
    height: z.number().optional().describe("New height"),
    name: z.string().optional().describe("New name"),
    fillColor: z.string().optional().describe("New fill color as hex"),
    opacity: z.number().optional().describe("Opacity 0-1"),
    cornerRadius: z.number().optional().describe("Corner radius"),
    visible: z.boolean().optional().describe("Visibility"),
    rotation: z.number().optional().describe("Rotation in degrees"),
    // Text-specific
    characters: z.string().optional().describe("(Text nodes) New text content"),
    fontSize: z.number().optional().describe("(Text nodes) New font size"),
    textAlignHorizontal: z
      .enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"])
      .optional()
      .describe("(Text nodes) Horizontal alignment"),
    // Auto-layout child properties
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("How this node sizes horizontally in auto-layout parent"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("How this node sizes vertically in auto-layout parent"),
    layoutAlign: z
      .enum(["INHERIT", "STRETCH", "MIN", "CENTER", "MAX"])
      .optional()
      .describe("Cross-axis alignment override within auto-layout parent"),
    layoutGrow: z
      .number()
      .optional()
      .describe("Flex grow factor (0 = fixed, 1 = fill remaining space)"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("modify_node", params)
);

// 10. Set Stroke
server.tool(
  "set_stroke",
  "Add or modify the stroke (border) on a node.",
  {
    nodeId: z.string().describe("ID of the node"),
    color: z.string().optional().describe("Stroke color as hex (default: '#000000')"),
    weight: z.number().optional().describe("Stroke weight in pixels (default: 1)"),
    strokeAlign: z
      .enum(["INSIDE", "OUTSIDE", "CENTER"])
      .optional()
      .describe("Stroke alignment (default: INSIDE)"),
    dashPattern: z
      .array(z.number())
      .optional()
      .describe("Dash pattern e.g. [4, 4] for dashed line"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("set_stroke", params)
);

// 11. Set Effects
server.tool(
  "set_effects",
  "Apply visual effects (drop shadow, inner shadow, layer blur, background blur) to a node. Replaces existing effects.",
  {
    nodeId: z.string().describe("ID of the node"),
    effects: z
      .array(
        z.object({
          type: z
            .enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"])
            .describe("Effect type"),
          color: z
            .string()
            .optional()
            .describe("Shadow color as hex with alpha e.g. '#00000040' (shadows only)"),
          offsetX: z.number().optional().describe("Horizontal shadow offset (shadows only)"),
          offsetY: z.number().optional().describe("Vertical shadow offset (shadows only)"),
          radius: z.number().optional().describe("Blur radius in pixels"),
          spread: z.number().optional().describe("Shadow spread (shadows only)"),
        })
      )
      .describe("Array of effects to apply"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("set_effects", params)
);

// 12. Delete Node
server.tool(
  "delete_node",
  "Delete a node from the Figma document.",
  {
    nodeId: z.string().describe("ID of the node to delete"),
  },
  async (params) => run("delete_node", params)
);

// 13. Get Selection
server.tool(
  "get_selection",
  "Get information about the currently selected nodes in Figma. Useful for understanding what the user is looking at or wants to modify.",
  {},
  async () => run("get_selection", {})
);

// 14. Get Page Structure
server.tool(
  "get_page_structure",
  "Get the hierarchical structure of all nodes on the current Figma page. Returns node IDs, names, types, positions, sizes, and children. Use this to understand the current state of the design.",
  {
    maxDepth: z
      .number()
      .optional()
      .describe("Maximum depth of the tree to return (default: 4)"),
  },
  async (params) => run("get_page_structure", params)
);

// 15. Move to Parent
server.tool(
  "move_to_parent",
  "Move a node into a different parent frame. Use this to restructure the layer hierarchy.",
  {
    nodeId: z.string().describe("ID of the node to move"),
    parentId: z.string().describe("ID of the new parent frame"),
    index: z
      .number()
      .optional()
      .describe("Position index within the parent's children (omit to append at end)"),
  },
  async (params) => run("move_to_parent", params)
);

// 16. Read Node Properties
server.tool(
  "read_node_properties",
  "Get detailed properties of a specific node by ID, including its children. Use this to inspect a node before modifying it.",
  {
    nodeId: z.string().describe("ID of the node to inspect"),
    depth: z
      .number()
      .optional()
      .describe("How deep to traverse children (default: 2)"),
  },
  async (params) => run("read_node_properties", params)
);

// ─── Export & Animation ─────────────────────────────────────────────────────

server.tool(
  "export_as_image",
  `Export a node in any Figma-supported export format. SVG returns markup text. PNG, JPG, and PDF return base64-encoded file content with mimeType metadata.`,
  {
    nodeId: z.string().describe("ID of the node to export."),
    format: z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format. Defaults to SVG."),
    exportChildren: z.boolean().optional().describe("If true, export all direct children individually."),
    constraintType: z.enum(["SCALE", "WIDTH", "HEIGHT"]).optional().describe("Optional image size constraint for PNG/JPG."),
    constraintValue: z.number().optional().describe("Constraint value used with constraintType."),
    svgOutlineText: z.boolean().optional().describe("SVG only. Defaults to true."),
    svgIdAttribute: z.boolean().optional().describe("SVG only. Include layer names as ids."),
    svgSimplifyStroke: z.boolean().optional().describe("SVG only. Defaults to true."),
    contentsOnly: z.boolean().optional().describe("Whether to export only the node contents."),
    useAbsoluteBounds: z.boolean().optional().describe("Whether to use uncropped node bounds."),
  },
  async (params) => run("export_as_image", params)
);

// Show Animation Preview
server.tool(
  "show_animation_preview",
  `Show animated SVG icons in a preview modal inside the Figma plugin. The modal displays all icons with their CSS animations playing live. Users can click individual icons to download, or use "Download Pack" to get a ZIP of all animated SVGs. Call this AFTER you've generated animated SVGs (with CSS @keyframes embedded in the SVG markup).`,
  {
    icons: z
      .array(
        z.object({
          name: z.string().describe("Display name of the icon (used as filename on download)"),
          svg: z
            .string()
            .describe(
              "Complete animated SVG markup with CSS @keyframes and animation properties embedded in a <style> block inside the SVG"
            ),
        })
      )
      .describe("Array of animated SVG icons to preview and make downloadable"),
  },
  async (params) => run("show_animation_preview", params)
);

// ─── Vector Drawing & Boolean Operations ────────────────────────────────────

// Create Vector (Pen Tool)
server.tool(
  "create_vector",
  `Create a vector node with custom paths — this is the pen tool. You can draw ANY shape by defining vertices and bezier curves via vectorNetwork, or by providing SVG path data strings via vectorPaths. This is the most powerful drawing tool — use it for complex custom shapes, organic forms, character illustrations, logos, and anything that can't be made with basic shapes. Supports fills (solid or gradient) and strokes.`,
  {
    name: z.string().optional().describe("Name of the vector"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width to resize to"),
    height: z.number().optional().describe("Height to resize to"),
    vectorNetwork: z
      .object({
        vertices: z
          .array(
            z.object({
              x: z.number().describe("X coordinate of vertex"),
              y: z.number().describe("Y coordinate of vertex"),
              strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional(),
              strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
              cornerRadius: z.number().optional(),
              handleMirroring: z.enum(["NONE", "ANGLE", "ANGLE_AND_LENGTH"]).optional(),
            })
          )
          .describe("Array of vertices (points) in the vector"),
        segments: z
          .array(
            z.object({
              start: z.number().describe("Index of start vertex"),
              end: z.number().describe("Index of end vertex"),
              tangentStart: z
                .object({ x: z.number(), y: z.number() })
                .optional()
                .describe("Bezier control point relative to start vertex. {x:0,y:0} = straight line"),
              tangentEnd: z
                .object({ x: z.number(), y: z.number() })
                .optional()
                .describe("Bezier control point relative to end vertex. {x:0,y:0} = straight line"),
            })
          )
          .describe("Array of segments connecting vertices. Use tangentStart/tangentEnd for curves"),
        regions: z
          .array(z.any())
          .optional()
          .describe("Array of regions (filled areas). Each region has a windingRule and loops array"),
      })
      .optional()
      .describe("Vector network defining the shape with vertices, bezier segments, and regions"),
    vectorPaths: z
      .array(
        z.object({
          windingRule: z
            .enum(["NONZERO", "EVENODD"])
            .optional()
            .describe("SVG fill rule (default: NONZERO)"),
          data: z
            .string()
            .describe("SVG path data string (M, L, C, Q, A, Z commands). e.g. 'M 0 0 L 100 0 L 100 100 Z'"),
        })
      )
      .optional()
      .describe("SVG path data strings — alternative to vectorNetwork. Use familiar SVG path syntax (M, L, C, Q, A, Z)"),
    fillColor: z.string().optional().describe("Fill color as hex"),
    gradient: z
      .object({
        type: z
          .enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"])
          .describe("Gradient type"),
        stops: z
          .array(
            z.object({
              color: z.string().describe("Stop color as hex"),
              position: z.number().describe("Stop position 0-1"),
            })
          )
          .describe("Gradient color stops"),
        gradientTransform: z
          .array(z.array(z.number()))
          .optional()
          .describe("2x3 transform matrix [[a,b,c],[d,e,f]]"),
      })
      .optional()
      .describe("Gradient fill (alternative to solid fillColor)"),
    strokeColor: z.string().optional().describe("Stroke color as hex"),
    strokeWeight: z.number().optional().describe("Stroke weight in pixels"),
    strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional(),
    strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_vector", params)
);

// Boolean Operations
server.tool(
  "boolean_operation",
  `Perform boolean operations on two or more nodes. UNION combines shapes, SUBTRACT cuts the second shape from the first, INTERSECT keeps only overlapping areas, EXCLUDE keeps only non-overlapping areas. The result replaces the input nodes.`,
  {
    nodeIds: z
      .array(z.string())
      .describe("Array of node IDs to combine (minimum 2). Order matters for SUBTRACT"),
    operation: z
      .enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"])
      .describe("Boolean operation type"),
    name: z.string().optional().describe("Name for the resulting node"),
  },
  async (params) => run("boolean_operation", params)
);

// Flatten Nodes
server.tool(
  "flatten_nodes",
  `Flatten one or more nodes into a single vector. Useful for converting shapes, frames, or groups into a single editable vector path. Similar to Object > Flatten in Figma.`,
  {
    nodeIds: z
      .array(z.string())
      .describe("Array of node IDs to flatten"),
    name: z.string().optional().describe("Name for the resulting vector"),
  },
  async (params) => run("flatten_nodes", params)
);

// Set Fill (advanced — supports gradients and multiple fills)
server.tool(
  "set_fill",
  `Set fills on a node. Supports solid colors, linear gradients, radial gradients, angular gradients, and diamond gradients. Can set multiple fills on a single node. Use this for advanced fill configurations that modify_node's simple fillColor can't handle.`,
  {
    nodeId: z.string().describe("ID of the node to set fills on"),
    fills: z
      .array(
        z.object({
          type: z
            .enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"])
            .describe("Fill type"),
          color: z.string().optional().describe("(SOLID only) Color as hex"),
          stops: z
            .array(
              z.object({
                color: z.string().describe("Stop color as hex"),
                position: z.number().describe("Stop position 0-1"),
              })
            )
            .optional()
            .describe("(Gradient only) Array of gradient color stops"),
          gradientTransform: z
            .array(z.array(z.number()))
            .optional()
            .describe("(Gradient only) 2x3 transform matrix [[a,b,c],[d,e,f]]"),
          visible: z.boolean().optional().describe("Whether this fill is visible (default: true)"),
        })
      )
      .describe("Array of fills to apply"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("set_fill", params)
);

// ─── Image Fill ─────────────────────────────────────────────────────────────

server.tool(
  "set_image_fill",
  `Apply an image fill to a node, or create a new image-filled rectangle. Provide exactly one of imagePath, imageBase64, imageBytes, or usePluginImage to place a real PNG/JPEG/GIF image. If no image source is provided, creates a styled placeholder rectangle using placeholderText.`,
  {
    nodeId: z.string().optional().describe("ID of existing node to fill. If omitted, creates a new rectangle."),
    placeholderText: z.string().optional().describe("Description of the image content. Used as the node name for the placeholder."),
    name: z.string().optional().describe("Name for the node"),
    imagePath: z.string().optional().describe("Local PNG/JPEG/GIF file path to upload into Figma. Absolute paths are recommended."),
    imageBase64: z.string().optional().describe("Base64-encoded PNG/JPEG/GIF image data. Data URLs are accepted."),
    imageBytes: z.array(z.number().int().min(0).max(255)).optional().describe("Raw PNG/JPEG/GIF bytes as an array of integers 0-255."),
    usePluginImage: z.boolean().optional().describe("Use the image uploaded in the plugin's Image Upload section."),
    x: z.number().optional().describe("X position (only when creating new)"),
    y: z.number().optional().describe("Y position (only when creating new)"),
    width: z.number().optional().describe("Width in pixels (only when creating new; defaults to the image width for real images, or 300 for placeholders)"),
    height: z.number().optional().describe("Height in pixels (only when creating new; defaults to the image height for real images, or 200 for placeholders)"),
    cornerRadius: z.number().optional().describe("Corner radius (only when creating new)"),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("How the image scales within the node (default: FILL)"),
    parentId: z.string().optional().describe("Parent frame ID (only when creating new)"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => {
    try {
      const imageSources = [
        params.imagePath,
        params.imageBase64,
        params.imageBytes,
        params.usePluginImage ? true : undefined,
      ].filter(Boolean);

      if (imageSources.length > 1) {
        return err("Provide only one image source: imagePath, imageBase64, imageBytes, or usePluginImage.");
      }

      const prepared: Record<string, unknown> = { ...params };

      if (params.imagePath) {
        prepared.imageBase64 = bytesToBase64(await readFile(params.imagePath));
        delete prepared.imagePath;
      } else if (params.imageBase64) {
        prepared.imageBase64 = params.imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
      } else if (params.imageBytes) {
        prepared.imageBase64 = bytesToBase64(Uint8Array.from(params.imageBytes));
        delete prepared.imageBytes;
      } else if (params.usePluginImage) {
        const ctx = await getPluginContext();
        if (!ctx.imageBase64) {
          return err("No image uploaded in the plugin. Please upload an image in the Image Upload section first.");
        }
        prepared.imageBase64 = ctx.imageBase64;
        prepared.name = params.name || ctx.imageName || "Uploaded Image";
        delete prepared.usePluginImage;
      }

      return await run("set_image_fill", prepared);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

// ─── Text Range Styling ─────────────────────────────────────────────────────

server.tool(
  "style_text_range",
  `Apply mixed styling within a single text node. Style different character ranges with different fonts, sizes, colors, and decorations. This enables rich text like headlines with colored keywords, mixed-weight paragraphs, hyperlinked words, etc. Each range specifies a start/end character index (0-based) and the styles to apply.`,
  {
    nodeId: z.string().describe("ID of the text node to style"),
    ranges: z
      .array(
        z.object({
          start: z.number().describe("Start character index (0-based, inclusive)"),
          end: z.number().describe("End character index (exclusive)"),
          fontFamily: z
            .string()
            .optional()
            .describe("Font family for this range, e.g. 'Poppins', 'Roboto', 'Playfair Display'. Must be available in Figma (use list_available_fonts to check)."),
          fontStyle: z
            .string()
            .optional()
            .describe("Font style: 'Regular', 'Bold', 'Semi Bold', 'Medium', 'Light', 'Italic', 'Bold Italic', etc."),
          fontSize: z.number().optional().describe("Font size in pixels"),
          fillColor: z.string().optional().describe("Text color as hex e.g. '#FF0000', '#1A1A2E'"),
          decoration: z
            .enum(["NONE", "UNDERLINE", "STRIKETHROUGH"])
            .optional()
            .describe("Text decoration"),
          letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
          lineHeight: z.number().optional().describe("Line height in pixels"),
          hyperlink: z.string().optional().describe("URL to link this text range to"),
        })
      )
      .describe("Array of text ranges with their styles"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("style_text_range", params)
);

// ─── Constraints ────────────────────────────────────────────────────────────

server.tool(
  "set_constraints",
  `Set responsive constraints on a node. Controls how the node behaves when its parent frame is resized. MIN=pin to left/top, CENTER=center, MAX=pin to right/bottom, STRETCH=pin both sides, SCALE=scale proportionally. Only works on children of non-auto-layout frames.`,
  {
    nodeId: z.string().describe("ID of the node to set constraints on"),
    horizontal: z
      .enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"])
      .optional()
      .describe("Horizontal constraint (default: MIN = pin left)"),
    vertical: z
      .enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"])
      .optional()
      .describe("Vertical constraint (default: MIN = pin top)"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("set_constraints", params)
);

// ─── Component Creation ─────────────────────────────────────────────────────

server.tool(
  "create_component",
  `Create a new main component. Components are reusable design elements — instances created from a component stay linked to it. Use this to define buttons, cards, inputs, and other reusable UI elements. Works like create_frame but produces a Component node.`,
  {
    name: z.string().optional().describe("Component name, e.g. 'Button/Primary', 'Card/Feature'"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width in pixels"),
    height: z.number().optional().describe("Height in pixels"),
    fillColor: z.string().optional().describe("Fill color as hex"),
    cornerRadius: z.number().optional().describe("Corner radius in pixels"),
    description: z.string().optional().describe("Component description for documentation"),
    parentId: z.string().optional().describe("Parent frame ID"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_component", params)
);

server.tool(
  "create_component_set",
  `Combine multiple components into a component set (variants). Each component becomes a variant. Name each component using 'Property=Value' format (e.g. 'Size=Large, State=Hover') before combining. Requires at least 2 components.`,
  {
    componentIds: z
      .array(z.string())
      .describe("Array of component node IDs to combine as variants (minimum 2)"),
    name: z.string().optional().describe("Name for the component set, e.g. 'Button'"),
  },
  async (params) => run("create_component_set", params)
);

// ─── Variables / Design Tokens ──────────────────────────────────────────────

server.tool(
  "create_variable_collection",
  `Create a new variable collection (design token group). Collections contain variables and can have multiple modes (e.g. Light/Dark theme). Use this to set up a design token system.`,
  {
    name: z.string().describe("Collection name, e.g. 'Colors', 'Spacing', 'Typography'"),
    modes: z
      .array(z.string())
      .optional()
      .describe("Mode names, e.g. ['Light', 'Dark']. First name replaces the default mode. Omit for a single default mode."),
  },
  async (params) => run("create_variable_collection", params)
);

server.tool(
  "create_variable",
  `Create a design token (variable) within a collection. Variables can be COLOR (hex), FLOAT (number), STRING, or BOOLEAN. Set different values per mode for theming. Bind to node properties with bind_variable.`,
  {
    name: z.string().describe("Variable name, e.g. 'primary-500', 'spacing-md', 'font-size-lg'"),
    collectionId: z.string().describe("ID of the variable collection to add this to"),
    type: z
      .enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
      .describe("Variable type"),
    values: z
      .record(z.string(), z.any())
      .optional()
      .describe("Values per mode. Keys are modeIds from the collection. COLOR values use hex strings ('#FF0000'), FLOAT uses numbers, STRING uses strings, BOOLEAN uses true/false."),
  },
  async (params) => run("create_variable", params)
);

server.tool(
  "bind_variable",
  `Bind a variable (design token) to a node property. When the variable value changes or the mode switches, the bound property updates automatically. Supports: opacity, visible, corner radii, padding, spacing, stroke weight, dimensions.`,
  {
    nodeId: z.string().describe("ID of the node to bind to"),
    variableId: z.string().describe("ID of the variable to bind"),
    field: z
      .string()
      .describe("Property to bind: 'opacity', 'visible', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing', 'strokeWeight', 'width', 'height'"),
  },
  async (params) => run("bind_variable", params)
);

server.tool(
  "get_variables",
  `Get all local variable collections and variables defined in the file. Use this to discover existing design tokens before creating new ones or binding them to nodes.`,
  {
    type: z
      .enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
      .optional()
      .describe("Filter by variable type"),
    limit: z.number().optional().describe("Max variables to return (default: 200)"),
  },
  async (params) => run("get_variables", params)
);

// ─── Font Discovery ─────────────────────────────────────────────────────────

server.tool(
  "list_available_fonts",
  `List fonts available in the Figma environment, grouped by family with their styles. Also returns 'projectFonts' — fonts already used in the file's text styles, representing the design system's typography choices. IMPORTANT: When a design system is connected, ALWAYS check projectFonts first and prefer using those fonts to maintain consistency. Use the query parameter to search for specific font families.`,
  {
    query: z
      .string()
      .optional()
      .describe("Search query to filter font families by name, e.g. 'Poppins', 'Roboto', 'Playfair'"),
    limit: z.number().optional().describe("Max font families to return (default: 50)"),
  },
  async (params) => run("list_available_fonts", params)
);

// ─── Design System Tools ────────────────────────────────────────────────────

// 17. List Components
server.tool(
  "list_components",
  `List all components and component sets in the Figma file. Returns component IDs, names, descriptions, and variant info. Use this to discover available design system components before creating designs. When a design system is available, ALWAYS prefer creating instances of existing components over building from scratch.`,
  {
    nameFilter: z
      .string()
      .optional()
      .describe("Filter components by name (case-insensitive partial match). E.g. 'button', 'card', 'input'"),
    pageOnly: z
      .boolean()
      .optional()
      .describe("If true, only search the current page. If false/omitted, search the entire file."),
    limit: z.number().optional().describe("Max results to return (default: 100)"),
  },
  async (params) => run("list_components", params)
);

// 18. Create Component Instance
server.tool(
  "create_component_instance",
  `Create an instance of an existing component. Use list_components first to find available components and their IDs. For component sets (variants), use the specific variant's ID, not the set ID.`,
  {
    componentId: z.string().describe("ID of the component to instantiate (from list_components)"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Override width"),
    height: z.number().optional().describe("Override height"),
    name: z.string().optional().describe("Custom instance name"),
    parentId: z.string().optional().describe("Parent frame ID to place inside"),
    agentId: z.string().optional().describe("Design agent ID — agent cursor animates to this element"),
  },
  async (params) => run("create_component_instance", params)
);

// 19. Detach Instance
server.tool(
  "detach_instance",
  "Detach a component instance, converting it into a regular frame. Useful when you need to customize an instance beyond its variant properties.",
  {
    nodeId: z.string().describe("ID of the component instance to detach"),
  },
  async (params) => run("detach_instance", params)
);

// 20. Get Local Styles
server.tool(
  "get_local_styles",
  `Get all local styles (colors, text styles, effect styles) defined in the Figma file. These represent the file's design tokens. Use these styles to maintain consistency when creating or editing designs.`,
  {},
  async () => run("get_local_styles", {})
);

server.tool(
  "scan_library",
  "Scan a Figma library file using the access token stored in the plugin Settings. Caches component sets, components, and styles for follow-up search calls.",
  {
    fileKey: z.string().optional().describe("Library file key. Provide either this or fileUrl."),
    fileUrl: z.string().optional().describe("Figma file URL for the library."),
  },
  async (params) => {
    try {
      const target = params.fileUrl || params.fileKey;
      if (!target) return err("Provide fileKey or fileUrl.");
      const scan = await scanLibraryFile(target);
      return ok({
        fileKey: scan.fileKey,
        fileName: scan.fileName,
        editorType: scan.editorType,
        lastScannedAt: scan.lastScannedAt,
        componentSetCount: scan.componentSets.length,
        componentCount: scan.components.length,
        styleCount: scan.styles.length,
      });
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
);

server.tool(
  "search_library_components",
  "Search previously scanned library assets by name or description.",
  {
    query: z.string().describe("Search text."),
    fileKey: z.string().optional().describe("Restrict search to one scanned library file."),
    type: z.enum(["COMPONENT_SET", "COMPONENT", "STYLE", "ALL"]).optional().describe("Asset type filter. Defaults to ALL."),
    limit: z.number().optional().describe("Maximum results to return."),
  },
  async (params) => {
    const query = params.query.trim().toLowerCase();
    if (!query) return err("Query is required.");

    const scans = params.fileKey
      ? [libraryScanCache.get(parseFigmaFileKey(params.fileKey))].filter(Boolean) as LibraryScanCache[]
      : Array.from(libraryScanCache.values());
    if (scans.length === 0) {
      return err("No scanned libraries found. Call scan_library first.");
    }

    const buckets = [];
    const requestedType = params.type || "ALL";
    for (const scan of scans) {
      if (requestedType === "ALL" || requestedType === "COMPONENT_SET") {
        buckets.push(...scan.componentSets.map((item) => ({ ...item, assetType: "COMPONENT_SET", libraryFileKey: scan.fileKey, libraryFileName: scan.fileName })));
      }
      if (requestedType === "ALL" || requestedType === "COMPONENT") {
        buckets.push(...scan.components.map((item) => ({ ...item, assetType: "COMPONENT", libraryFileKey: scan.fileKey, libraryFileName: scan.fileName })));
      }
      if (requestedType === "ALL" || requestedType === "STYLE") {
        buckets.push(...scan.styles.map((item) => ({ ...item, assetType: "STYLE", libraryFileKey: scan.fileKey, libraryFileName: scan.fileName })));
      }
    }

    const matches = buckets.filter((item) => {
      const record = item as Record<string, unknown>;
      const haystack = `${String(record.name || "")} ${String(record.description || "")}`.toLowerCase();
      return haystack.includes(query);
    });

    return ok({
      count: Math.min(matches.length, params.limit || 50),
      total: matches.length,
      results: matches.slice(0, params.limit || 50),
    });
  }
);

server.tool(
  "create_library_instance",
  "Import a published library component or component set by key and create an instance in the current file.",
  {
    key: z.string().describe("Published component or component set key."),
    variantName: z.string().optional().describe("Optional variant name when key points to a component set."),
    x: z.number().optional().describe("X position."),
    y: z.number().optional().describe("Y position."),
    width: z.number().optional().describe("Optional width override."),
    height: z.number().optional().describe("Optional height override."),
    name: z.string().optional().describe("Optional instance name."),
    parentId: z.string().optional().describe("Optional parent node id."),
    agentId: z.string().optional().describe("Optional agent id."),
  },
  async (params) => run("import_component_by_key", params)
);

server.tool(
  "get_library_info",
  "Get information about scanned libraries currently cached by the MCP server.",
  {
    fileKey: z.string().optional().describe("Optional file key to inspect a single scanned library."),
  },
  async (params) => {
    const scans = params.fileKey
      ? [libraryScanCache.get(parseFigmaFileKey(params.fileKey))].filter(Boolean) as LibraryScanCache[]
      : Array.from(libraryScanCache.values());
    if (scans.length === 0) return ok({ libraries: [] });

    return ok({
      libraries: scans.map((scan) => ({
        fileKey: scan.fileKey,
        fileName: scan.fileName,
        editorType: scan.editorType,
        lastScannedAt: scan.lastScannedAt,
        componentSetCount: scan.componentSets.length,
        componentCount: scan.components.length,
        styleCount: scan.styles.length,
      })),
    });
  }
);

// ─── Search & Edit Tools ────────────────────────────────────────────────────

// 21. Find Nodes
server.tool(
  "find_nodes",
  `Search for nodes by name or type on the current page. Also searches text content for text nodes. Use this to find existing elements before editing them. For example, find all buttons, headers, or nodes matching a name pattern.`,
  {
    query: z
      .string()
      .optional()
      .describe("Search query — matches against node names and text content (case-insensitive)"),
    type: z
      .string()
      .optional()
      .describe("Filter by node type: FRAME, TEXT, RECTANGLE, ELLIPSE, COMPONENT, INSTANCE, GROUP, etc."),
    rootNodeId: z
      .string()
      .optional()
      .describe("Search within a specific subtree (node ID). Omit to search the entire current page."),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },
  async (params) => run("find_nodes", params)
);

// 22. Set Selection
server.tool(
  "set_selection",
  "Select specific nodes in Figma and scroll the viewport to show them. Useful for highlighting elements for the user.",
  {
    nodeIds: z
      .array(z.string())
      .describe("Array of node IDs to select"),
  },
  async (params) => run("set_selection", params)
);

server.tool(
  "get_uploaded_image_status",
  "Check whether an image has been uploaded in the plugin Image Upload section.",
  {},
  async () => {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          available: uploadedImageInfo.available,
          name: uploadedImageInfo.name,
          size: uploadedImageInfo.size,
          mimeType: uploadedImageInfo.mimeType,
          tip: uploadedImageInfo.available
            ? "Image is ready. Call set_image_fill with usePluginImage: true to use it."
            : "No image uploaded. Ask the user to upload an image in the plugin Image Upload section.",
        }),
      }],
    };
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  log("Starting figma_editor...");
  log(`WebSocket bridge target ws://localhost:${WS_PORT}`);
  log("Waiting for MCP client to connect via stdio...");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("MCP server connected — ready to receive tool calls");
}

main().catch((e) => {
  log("Fatal error:", e);
  process.exit(1);
});
