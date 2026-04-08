/**
 * SlackBot — Bolt app wrapper for Slack Socket Mode.
 *
 * Handles:
 *   - Bot creation and Socket Mode lifecycle
 *   - Inbound DM message parsing → ACP prompt() to Host
 *   - Action handling for interactive components
 */

import path from "node:path";
import { App } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import { extractErrorMessage } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";
import { downloadSlackFile } from "./media-download.js";

export interface SlackConfig {
  bot_token: string;
  app_token: string;
}

type LogFn = (level: string, msg: string) => void;

export class SlackBot {
  readonly app: App;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  private botUserId: string | null = null;

  constructor(config: SlackConfig, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;

    this.app = new App({
      token: config.bot_token,
      appToken: config.app_token,
      socketMode: true,
      // Disable built-in HTTP receiver — we're stdio-only
    });

    this.registerHandlers();
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  async start(): Promise<void> {
    await this.app.start();
    // Get bot user ID for filtering
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id as string;
    this.log("info", `bot started (Socket Mode), bot_user_id=${this.botUserId}`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private registerHandlers(): void {
    // Listen for DM messages only
    this.app.message(async ({ message, say }) => {
      // Filter: only handle DM messages (channel_type === 'im')
      const msg = message as GenericMessageEvent;
      if (msg.channel_type !== "im") return;

      // Ignore bot's own messages, edits, and deletes — but allow file_share
      if (msg.subtype && msg.subtype !== "file_share") return;
      if (msg.bot_id) return;
      if (msg.user === this.botUserId) return;

      const chatId = msg.channel;
      const text = msg.text ?? "";
      const userId = msg.user;

      if (!text && (!msg.files || msg.files.length === 0)) return;

      this.log("debug", `dm chat=${chatId} user=${userId} text=${text.slice(0, 80)}`);

      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      if (text) {
        contentBlocks.push({ type: "text", text });
      }

      // Handle file attachments — download locally since Slack URLs need auth
      if (msg.files && msg.files.length > 0) {
        for (const file of msg.files) {
          const isImage = file.mimetype?.startsWith("image/") ?? false;
          if (!text) {
            contentBlocks.push({
              type: "text",
              text: `The user sent ${isImage ? "an image" : "a file"}: ${file.name ?? "unnamed"}`,
            });
          }
          if (file.url_private && file.id) {
            const media = await downloadSlackFile({
              botToken: this.app.client.token!,
              urlPrivate: file.url_private,
              fileId: file.id,
              cacheDir: this.cacheDir,
              chatId,
              mimeType: file.mimetype ?? "application/octet-stream",
              fileName: file.name ?? undefined,
            });
            if (media) {
              contentBlocks.push({
                type: "resource_link",
                uri: `file://${media.path}`,
                name: media.fileName ?? path.basename(media.path),
                mimeType: media.mimeType,
              });
            }
          }
        }
      }

      if (contentBlocks.length === 0) return;

      // Notify stream handler before prompt
      this.streamHandler?.onPromptSent(chatId);

      // Add hourglass reaction as typing indicator
      await this.app.client.reactions.add({
        channel: chatId,
        timestamp: msg.ts,
        name: "hourglass_flowing_sand",
      }).catch(() => {});

      try {
        const response = await this.agent.prompt({
          sessionId: chatId,
          prompt: contentBlocks,
        });
        this.log("info", `prompt done chat=${chatId} stopReason=${response.stopReason}`);
        this.streamHandler?.onTurnEnd(chatId);
      } catch (error: unknown) {
        const errMsg = extractErrorMessage(error);
        this.log("error", `prompt failed chat=${chatId}: ${errMsg}`);
        this.streamHandler?.onTurnError(chatId, errMsg);
      } finally {
        // Remove hourglass reaction
        await this.app.client.reactions.remove({
          channel: chatId,
          timestamp: msg.ts,
          name: "hourglass_flowing_sand",
        }).catch(() => {});
      }
    });

    // Handle /va and /vibearound slash commands — forward as /<rest> to the agent
    for (const cmd of ["/va", "/vibearound"]) {
      this.app.command(cmd, async ({ command, ack }) => {
        await ack();
        const chatId = command.channel_id;
        const text = command.text?.trim() ?? "";
        const userId = command.user_id;

        // Reconstruct as a slash command: "/va help" → "/va help" (parser strips prefix)
        const fullText = text ? `${cmd} ${text}` : cmd;
        this.log("debug", `slash cmd=${cmd} chat=${chatId} user=${userId} text=${text}`);

        const contentBlocks: ContentBlock[] = [{ type: "text", text: fullText }];

        this.streamHandler?.onPromptSent(chatId);

        try {
          const response = await this.agent.prompt({
            sessionId: chatId,
            prompt: contentBlocks,
          });
          this.log("info", `slash prompt done chat=${chatId} stopReason=${response.stopReason}`);
          this.streamHandler?.onTurnEnd(chatId);
        } catch (error: unknown) {
          const errMsg = extractErrorMessage(error);
          this.log("error", `slash prompt failed chat=${chatId}: ${errMsg}`);
          this.streamHandler?.onTurnError(chatId, errMsg);
        }
      });
    }

    // Handle interactive actions (button clicks from permission prompts, etc.)
    this.app.action(/^va_action_.*/, async ({ action, ack, body }) => {
      await ack();
      const channelId = (body as any).channel?.id;
      if (!channelId) return;

      this.agent.extNotification?.("channel/callback", {
        channelId: `slack:${channelId}`,
        callbackId: (action as any).action_id,
        sender: {
          id: (body as any).user?.id ?? "",
          name: (body as any).user?.name ?? "",
        },
        data: (action as any).value ?? (action as any).selected_option?.value ?? "",
      }).catch(() => {});
    });
  }
}
