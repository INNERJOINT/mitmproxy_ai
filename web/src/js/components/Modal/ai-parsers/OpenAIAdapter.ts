import type { AIAnalyzerEvent, AIProtocolParser, WsMessage } from "./types";

export class OpenAIAdapter implements AIProtocolParser {
    name = "OpenAI API";

    canParse(msg: WsMessage, parsedJson?: any): boolean {
        if (msg.from_client && parsedJson) {
            return Boolean(
                typeof parsedJson.model === "string" &&
                    !parsedJson.model.startsWith("claude") &&
                    Array.isArray(parsedJson.messages),
            );
        }

        if (!msg.from_client) {
            if (parsedJson?.object === "chat.completion") {
                return true;
            }
            if (
                msg.text &&
                msg.text.includes("chat.completion.chunk") &&
                msg.text.includes("data:")
            ) {
                return true;
            }
        }

        if (parsedJson && typeof parsedJson.type === "string") {
            const types = [
                "response.",
                "session.",
                "codex.",
                "input_audio_buffer.",
                "conversation.",
                "rate_limits",
            ];
            return types.some((prefix) => parsedJson.type.startsWith(prefix));
        }
        return false;
    }

    parse(msg: WsMessage, parsedJson?: any): AIAnalyzerEvent[] {
        if (msg.from_client && parsedJson?.model && Array.isArray(parsedJson.messages)) {
            return this.parseChatCompletionRequest(msg, parsedJson);
        }
        if (!msg.from_client && parsedJson?.object === "chat.completion") {
            return this.parseChatCompletionResponse(msg, parsedJson);
        }
        if (
            !msg.from_client &&
            msg.text?.includes("chat.completion.chunk") &&
            msg.text.includes("data:")
        ) {
            return this.parseChatCompletionStream(msg);
        }
        return this.parseRealtimeEvent(msg, parsedJson);
    }

    private baseEvent(msg: WsMessage, raw: any) {
        return {
            id: `${msg.timestamp}-${Math.random()}`,
            timestamp: msg.timestamp,
            direction: msg.from_client ? "outgoing" : "incoming",
            provider: this.name,
            raw,
        } as const;
    }

    private stringifyContent(content: any): string {
        if (content == null) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .map((item) => {
                    if (item && typeof item === "object") {
                        return item.text || JSON.stringify(item, null, 2);
                    }
                    return String(item);
                })
                .join("\n");
        }
        return JSON.stringify(content, null, 2);
    }

    private formatToolCall(toolCall: any): string | null {
        const fn = toolCall?.function;
        if (!fn) return null;
        let args = fn.arguments ?? "";
        if (typeof args === "string") {
            try {
                args = JSON.stringify(JSON.parse(args), null, 2);
            } catch {
                // keep original string
            }
        } else {
            args = JSON.stringify(args, null, 2);
        }
        const id = toolCall.id ? ` (${toolCall.id})` : "";
        return `[Tool: ${fn.name || "unknown"}]${id}\n${args}`;
    }

    private parseChatCompletionRequest(
        msg: WsMessage,
        parsedJson: any,
    ): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, parsedJson);

        parsedJson.messages.forEach((message: any, index: number) => {
            const raw = message;
            const eventBase = {
                ...baseEvent,
                id: `${msg.timestamp}-chat-${index}`,
                raw,
            };
            if (message.role === "system") {
                events.push({
                    ...eventBase,
                    type: "system_prompt",
                    content: this.stringifyContent(message.content),
                });
            } else if (message.role === "user") {
                events.push({
                    ...eventBase,
                    type: "user_message",
                    content: this.stringifyContent(message.content),
                });
            } else if (message.role === "assistant") {
                const content = [
                    message.reasoning_content
                        ? `[Reasoning]\n${message.reasoning_content}`
                        : "",
                    this.stringifyContent(message.content),
                ]
                    .filter(Boolean)
                    .join("\n");
                if (content) {
                    events.push({
                        ...eventBase,
                        type: "assistant_stream",
                        content,
                    });
                }
                for (const toolCall of message.tool_calls || []) {
                    const formatted = this.formatToolCall(toolCall);
                    if (formatted) {
                        events.push({
                            ...eventBase,
                            id: `${msg.timestamp}-chat-${index}-${toolCall.id || Math.random()}`,
                            type: "tool_call",
                            content: formatted,
                            raw: toolCall,
                        });
                    }
                }
            } else if (message.role === "tool") {
                events.push({
                    ...eventBase,
                    type: "tool_result",
                    content: `[Tool Result: ${message.tool_call_id || "unknown"}]\n${this.stringifyContent(message.content)}`,
                });
            }
        });

        events.push({
            ...baseEvent,
            id: `${msg.timestamp}-chat-meta`,
            type: "meta",
            content: `Model: ${parsedJson.model}`,
            raw: { model: parsedJson.model },
        });

        return events;
    }

    private parseChatCompletionResponse(
        msg: WsMessage,
        parsedJson: any,
    ): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, parsedJson);

        for (const choice of parsedJson.choices || []) {
            const message = choice.message || {};
            const index = choice.index ?? 0;
            const content = [
                message.reasoning_content
                    ? `[Reasoning]\n${message.reasoning_content}`
                    : "",
                this.stringifyContent(message.content),
            ]
                .filter(Boolean)
                .join("\n");
            if (content) {
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-choice-${index}`,
                    type: "assistant_stream",
                    content,
                    raw: choice,
                });
            }
            for (const toolCall of message.tool_calls || []) {
                const formatted = this.formatToolCall(toolCall);
                if (formatted) {
                    events.push({
                        ...baseEvent,
                        id: `${msg.timestamp}-choice-${index}-${toolCall.id || Math.random()}`,
                        type: "tool_call",
                        content: formatted,
                        raw: toolCall,
                    });
                }
            }
            if (choice.finish_reason) {
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-choice-${index}-finish`,
                    type: "meta",
                    content: `Finish reason: ${choice.finish_reason}`,
                    raw: choice,
                });
            }
        }

        if (parsedJson.usage) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-usage`,
                type: "meta",
                content: `Usage: In ${parsedJson.usage.prompt_tokens || 0}, Out ${parsedJson.usage.completion_tokens || 0}`,
                raw: { usage: parsedJson.usage },
            });
        }

        return events;
    }

    private parseChatCompletionStream(msg: WsMessage): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, msg.text);
        const toolCalls = new Map<
            string,
            { id?: string; name: string; arguments: string; raw: any[] }
        >();

        for (const line of msg.text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.substring(6).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
                const data = JSON.parse(dataStr);
                if (data.object !== "chat.completion.chunk") continue;

                if (data.usage) {
                    events.push({
                        ...baseEvent,
                        id: `${msg.timestamp}-usage`,
                        type: "meta",
                        content: `Usage: In ${data.usage.prompt_tokens || 0}, Out ${data.usage.completion_tokens || 0}`,
                        raw: data,
                    });
                }

                for (const choice of data.choices || []) {
                    const delta = choice.delta || {};
                    if (delta.reasoning_content) {
                        events.push({
                            ...baseEvent,
                            id: `${msg.timestamp}-reasoning-${events.length}`,
                            type: "meta",
                            content: `[Reasoning]\n${delta.reasoning_content}`,
                            raw: data,
                        });
                    }
                    if (delta.content) {
                        events.push({
                            ...baseEvent,
                            id: `${msg.timestamp}-content-${events.length}`,
                            type: "assistant_stream",
                            content: delta.content,
                            raw: data,
                        });
                    }
                    for (const toolCall of delta.tool_calls || []) {
                        const index = toolCall.index ?? 0;
                        const key = `${choice.index ?? 0}:${index}`;
                        const current = toolCalls.get(key) || {
                            id: undefined,
                            name: "",
                            arguments: "",
                            raw: [],
                        };
                        if (toolCall.id) current.id = toolCall.id;
                        if (toolCall.function?.name) {
                            current.name += toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                            current.arguments += toolCall.function.arguments;
                        }
                        current.raw.push(data);
                        toolCalls.set(key, current);
                    }
                    if (choice.finish_reason) {
                        events.push({
                            ...baseEvent,
                            id: `${msg.timestamp}-finish-${events.length}`,
                            type: "meta",
                            content: `Finish reason: ${choice.finish_reason}`,
                            raw: data,
                        });
                    }
                }
            } catch {
                // ignore unparseable data line
            }
        }

        for (const [key, toolCall] of toolCalls) {
            const formatted = this.formatToolCall({
                id: toolCall.id,
                function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                },
            });
            if (formatted) {
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-tool-${key}`,
                    type: "tool_call",
                    content: formatted,
                    raw: toolCall.raw,
                });
            }
        }

        if (events.length === 0) {
            events.push({
                ...baseEvent,
                type: "unknown",
                content: "Could not extract stream chunks.",
            });
        }

        return events;
    }

    private parseRealtimeEvent(
        msg: WsMessage,
        parsedJson?: any,
    ): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, parsedJson || msg.text);

        if (!parsedJson) {
            return [{ ...baseEvent, type: "unknown" as const }];
        }

        const type = parsedJson.type;

        if (type === "response.create") {
            if (parsedJson.instructions) {
                events.push({
                    ...baseEvent,
                    type: "system_prompt",
                    content: parsedJson.instructions,
                });
            } else if (parsedJson.response?.instructions) {
                events.push({
                    ...baseEvent,
                    type: "system_prompt",
                    content: parsedJson.response.instructions,
                });
            }

            const inputArr = parsedJson.input || parsedJson.response?.input;
            if (Array.isArray(inputArr)) {
                for (const item of inputArr) {
                    if (item.role === "user" && Array.isArray(item.content)) {
                        const textContent = item.content.find(
                            (c: any) =>
                                c.type === "input_text" || c.type === "text",
                        )?.text;
                        events.push({
                            ...baseEvent,
                            type: "user_message",
                            content: textContent || "<Media/Audio Input>",
                        });
                    }
                }
            }

            if (events.length === 0) {
                events.push({
                    ...baseEvent,
                    type: "user_message",
                    content: "<Trigger Response>",
                });
            }
        } else if (type === "conversation.item.create") {
            const item = parsedJson.item;
            if (item?.role === "user" && Array.isArray(item.content)) {
                const textContent = item.content.find(
                    (c: any) => c.type === "input_text" || c.type === "text",
                )?.text;
                events.push({
                    ...baseEvent,
                    type: "user_message",
                    content: textContent || "<Media/Audio Input>",
                });
            } else {
                events.push({
                    ...baseEvent,
                    type: "meta",
                    content: "Conversation Item Created",
                });
            }
        } else if (type === "response.text.delta") {
            events.push({
                ...baseEvent,
                type: "assistant_stream",
                content: parsedJson.delta,
            });
        } else if (type === "response.done") {
            events.push({
                ...baseEvent,
                type: "meta",
                content: "Response Complete",
            });
        } else if (type === "codex.rate_limits") {
            events.push({
                ...baseEvent,
                type: "meta",
                content: "Rate Limits Info",
            });
        } else {
            events.push({
                ...baseEvent,
                type: "unknown",
            });
        }

        return events;
    }
}
