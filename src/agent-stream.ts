/**
 * Slack stream renderer — extends BlockRenderer with Slack-specific transport.
 */

import {
  BlockRenderer,
  type BlockKind,
  type RequestPermissionRequest,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { SlackBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private slackBot: SlackBot;
  private log: LogFn;

  constructor(slackBot: SlackBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.slackBot = slackBot;
    this.log = log;
  }

  /** Render permission request as a Block Kit actions block. */
  protected async onRequestPermission(
    chatId: string,
    request: RequestPermissionRequest,
    callbackId: string,
  ): Promise<void> {
    const options = request.options ?? [];
    const toolTitle =
      (request.toolCall as { title?: string } | undefined)?.title ?? "the agent";

    const elements = options.map((opt) => ({
      type: "button" as const,
      action_id: `va_permission_${callbackId}_${opt.optionId}`,
      text: { type: "plain_text" as const, text: opt.name },
      value: JSON.stringify({ callbackId, optionId: opt.optionId, optionName: opt.name }),
      style: slackButtonStyle(opt.kind),
    }));

    await this.slackBot.app.client.chat.postMessage({
      channel: chatId,
      text: `🔐 Permission required — ${toolTitle}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔐 *Permission required* — \`${toolTitle}\``,
          },
        },
        { type: "actions", elements },
      ],
    });
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    await this.slackBot.app.client.chat.postMessage({ channel: chatId, text });
  }

  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `_\u{1F4AD} ${content}_`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      const result = await this.slackBot.app.client.chat.postMessage({ channel: chatId, text: content });
      return result.ts ?? null;
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  protected async editBlock(
    chatId: string,
    ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    try {
      await this.slackBot.app.client.chat.update({ channel: chatId, ts: ref, text: content });
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }
}

/** Map permission option kinds to Slack Block Kit button styles. */
function slackButtonStyle(kind: string): "primary" | "danger" | undefined {
  switch (kind) {
    case "allow_once":
    case "allow_always":
      return "primary";
    case "reject_once":
    case "reject_always":
      return "danger";
    default:
      return undefined;
  }
}
