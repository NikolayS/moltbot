/**
 * Type declarations for Clawdbot plugin SDK
 * These types are provided by the clawdbot peer dependency at runtime
 */
declare module "clawdbot/plugin-sdk" {
  import { TSchema } from "@sinclair/typebox";

  // Commander-like program interface
  interface Command {
    command(name: string): Command;
    description(desc: string): Command;
    option(flags: string, desc: string, defaultValue?: string): Command;
    argument(name: string, desc: string): Command;
    action(fn: (...args: any[]) => Promise<void> | void): Command;
  }

  export interface ClawdbotPluginApi {
    pluginConfig: unknown;
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    registerTool: (
      tool: {
        name: string;
        label: string;
        description: string;
        parameters: TSchema;
        execute: (
          toolCallId: string,
          params: unknown,
          ctx?: { sessionKey?: string }
        ) => Promise<{
          content: Array<{ type: string; text: string }>;
          details?: Record<string, unknown>;
        }>;
      },
      opts: { name: string }
    ) => void;
    registerCli: (
      fn: (opts: { program: Command }) => void,
      opts: { commands: string[] }
    ) => void;
    registerService: (service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }) => void;
    on: (
      event: "before_agent_start" | "agent_end",
      handler: (event: {
        prompt?: string;
        sessionKey?: string;
        success?: boolean;
        messages?: Array<{
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
        }>;
      }) => Promise<void | { prependContext?: string }>
    ) => void;
  }

  export function stringEnum<T extends readonly string[]>(
    values: T
  ): TSchema;
}
