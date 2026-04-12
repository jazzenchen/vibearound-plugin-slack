/**
 * Slack stream renderer — extends BlockRenderer with Slack-specific transport.
 */

import {
  BlockRenderer,
  type BlockKind,
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
