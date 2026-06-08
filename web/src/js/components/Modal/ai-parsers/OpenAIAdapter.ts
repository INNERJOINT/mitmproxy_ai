import type { AIAnalyzerEvent, AIProtocolParser, WsMessage } from "./types";

export class OpenAIAdapter implements AIProtocolParser {
    name = "OpenAI API";

    private maxSseEvents = 5000;
    private maxSseDataChars = 64_000;
    private maxAccumulatedChars = 1_000_000;

    canParse(msg: WsMessage, parsedJson?: any): boolean {
        if (msg.from_client && parsedJson) {
            return Boolean(
                typeof parsedJson.model === "string" &&
                    !parsedJson.model.startsWith("claude") &&
                    (Array.isArray(parsedJson.messages) || "input" in parsedJson),
            );
        }

        if (!msg.from_client) {
            if (
                parsedJson?.object === "chat.completion" ||
                parsedJson?.object === "response"
            ) {
                return true;
            }
            if (
                msg.text &&
                msg.text.includes("chat.completion.chunk") &&
                msg.text.includes("data:")
            ) {
                return true;
            }
            if (
                msg.text &&
                msg.text.includes("response.") &&
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
        if (msg.from_client && parsedJson?.model && "input" in parsedJson) {
            return this.parseResponsesRequest(msg, parsedJson);
        }
        if (!msg.from_client && parsedJson?.object === "chat.completion") {
            return this.parseChatCompletionResponse(msg, parsedJson);
        }
        if (!msg.from_client && parsedJson?.object === "response") {
            return this.parseResponsesResponse(msg, parsedJson);
        }
        if (
            !msg.from_client &&
            msg.text?.includes("chat.completion.chunk") &&
            msg.text.includes("data:")
        ) {
            return this.parseChatCompletionStream(msg);
        }
        if (
            !msg.from_client &&
            msg.text?.includes("response.") &&
            msg.text.includes("data:")
        ) {
            return this.parseResponsesStream(msg);
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

    private appendLimited(
        parts: string[],
        value: string,
        state: { chars: number },
    ): string {
        const remaining = this.maxAccumulatedChars - state.chars;
        if (remaining <= 0) return "";
        const clipped = value.slice(0, remaining);
        parts.push(clipped);
        state.chars += clipped.length;
        return clipped;
    }

    private formatFunctionCall(
        name: string | undefined,
        args: any,
        id?: string,
    ): string {
        if (typeof args === "string") {
            try {
                args = JSON.stringify(JSON.parse(args), null, 2);
            } catch {
                // keep original string
            }
        } else {
            args = JSON.stringify(args ?? {}, null, 2);
        }
        const idLabel = id ? ` (${id})` : "";
        return `[Tool: ${name || "unknown"}]${idLabel}\n${args}`;
    }

    private formatToolCall(toolCall: any): string | null {
        const fn = toolCall?.function;
        if (!fn) return null;
        return this.formatFunctionCall(fn.name, fn.arguments ?? "", toolCall.id);
    }

    private parseResponsesInputItem(
        msg: WsMessage,
        parsedJson: any,
        item: any,
        index: number,
    ): AIAnalyzerEvent[] {
        const baseEvent = this.baseEvent(msg, parsedJson);
        const eventBase = {
            ...baseEvent,
            id: `${msg.timestamp}-responses-input-${index}`,
            raw: item,
        };
        if (item?.type === "message") {
            if (item.role === "developer" || item.role === "system") {
                return [
                    {
                        ...eventBase,
                        type: "system_prompt",
                        content: this.stringifyContent(item.content),
                    },
                ];
            }
            if (item.role === "user") {
                return [
                    {
                        ...eventBase,
                        type: "user_message",
                        content: this.stringifyContent(item.content),
                    },
                ];
            }
            if (item.role === "assistant") {
                return [
                    {
                        ...eventBase,
                        type: "assistant_stream",
                        content: this.stringifyContent(item.content),
                    },
                ];
            }
        }
        if (item?.type === "function_call") {
            return [
                {
                    ...eventBase,
                    type: "tool_call",
                    content: this.formatFunctionCall(
                        item.name,
                        item.arguments ?? "",
                        item.call_id,
                    ),
                },
            ];
        }
        if (item?.type === "function_call_output") {
            return [
                {
                    ...eventBase,
                    type: "tool_result",
                    content: `[Tool Result: ${item.call_id || "unknown"}]\n${this.stringifyContent(item.output ?? item.content)}`,
                },
            ];
        }
        if (item?.type === "reasoning") {
            return [
                {
                    ...eventBase,
                    type: "meta",
                    content: `[Reasoning Summary]\n${this.stringifyContent(item.summary)}`,
                },
            ];
        }
        return [
            {
                ...eventBase,
                type: "meta",
                content: `Input item: ${item?.type || "unknown"}`,
            },
        ];
    }

    private parseResponsesOutputItem(
        msg: WsMessage,
        parsedJson: any,
        item: any,
        index: number,
    ): AIAnalyzerEvent[] {
        const baseEvent = this.baseEvent(msg, parsedJson);
        const eventBase = {
            ...baseEvent,
            id: `${msg.timestamp}-responses-output-${index}`,
            raw: item,
        };
        if (item?.type === "message") {
            return [
                {
                    ...eventBase,
                    type: "assistant_stream",
                    content: this.stringifyContent(item.content),
                },
            ];
        }
        if (item?.type === "reasoning") {
            return [
                {
                    ...eventBase,
                    type: "meta",
                    content: `[Reasoning Summary]\n${this.stringifyContent(item.summary)}`,
                },
            ];
        }
        if (item?.type === "function_call") {
            return [
                {
                    ...eventBase,
                    type: "tool_call",
                    content: this.formatFunctionCall(
                        item.name,
                        item.arguments ?? "",
                        item.call_id,
                    ),
                },
            ];
        }
        if (item?.type === "function_call_output") {
            return [
                {
                    ...eventBase,
                    type: "tool_result",
                    content: `[Tool Result: ${item.call_id || "unknown"}]\n${this.stringifyContent(item.output ?? item.content)}`,
                },
            ];
        }
        return [
            {
                ...eventBase,
                type: "meta",
                content: `Output item: ${item?.type || "unknown"}`,
            },
        ];
    }

    private summarizeSseEvent(data: any): any {
        return {
            type: data.type,
            object: data.object,
            id: data.id || data.response?.id,
            model: data.model || data.response?.model,
            output_index: data.output_index,
            item_id: data.item_id,
            status: data.status || data.response?.status,
            usage: data.usage || data.response?.usage,
        };
    }

    private *parseSseDataLines(text: string): Generator<any> {
        let count = 0,
            start = 0;
        while (start <= text.length && count < this.maxSseEvents) {
            const end = text.indexOf("\n", start);
            const line = text.slice(start, end === -1 ? text.length : end);
            start = end === -1 ? text.length + 1 : end + 1;
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.substring(6).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            if (dataStr.length > this.maxSseDataChars) continue;
            try {
                const data = JSON.parse(dataStr);
                count += 1;
                yield data;
            } catch {
                // ignore unparseable data line
            }
        }
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
        const baseEvent = this.baseEvent(msg, {
            stream: "openai.chat.completions",
        });
        const toolCalls = new Map<
            string,
            { id?: string; name: string; arguments: string; raw: any }
        >();
        const textState = { chars: 0 };
        const toolState = { chars: 0 };

        for (const data of this.parseSseDataLines(msg.text)) {
            try {
                if (data.object !== "chat.completion.chunk") continue;

                const raw = this.summarizeSseEvent(data);

                if (data.usage) {
                    events.push({
                        ...baseEvent,
                        id: `${msg.timestamp}-usage`,
                        type: "meta",
                        content: `Usage: In ${data.usage.prompt_tokens || 0}, Out ${data.usage.completion_tokens || 0}`,
                        raw,
                    });
                }

                for (const choice of data.choices || []) {
                    const delta = choice.delta || {};
                    if (delta.reasoning_content) {
                        const reasoning = this.appendLimited(
                            [],
                            delta.reasoning_content,
                            textState,
                        );
                        if (reasoning) {
                            events.push({
                                ...baseEvent,
                                id: `${msg.timestamp}-reasoning-${events.length}`,
                                type: "meta",
                                content: `[Reasoning]\n${reasoning}`,
                                raw,
                            });
                        }
                    }
                    if (delta.content) {
                        const content = this.appendLimited(
                            [],
                            delta.content,
                            textState,
                        );
                        if (content) {
                            events.push({
                                ...baseEvent,
                                id: `${msg.timestamp}-content-${events.length}`,
                                type: "assistant_stream",
                                content,
                                raw,
                            });
                        }
                    }
                    for (const toolCall of delta.tool_calls || []) {
                        const index = toolCall.index ?? 0;
                        const key = `${choice.index ?? 0}:${index}`;
                        const current = toolCalls.get(key) || {
                            id: undefined,
                            name: "",
                            arguments: "",
                            raw: { object: data.object, model: data.model },
                        };
                        if (toolCall.id) current.id = toolCall.id;
                        if (toolCall.function?.name) {
                            current.name += toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                            const parts = [current.arguments];
                            this.appendLimited(
                                parts,
                                toolCall.function.arguments,
                                toolState,
                            );
                            current.arguments = parts.join("");
                        }
                        toolCalls.set(key, current);
                    }
                    if (choice.finish_reason) {
                        events.push({
                            ...baseEvent,
                            id: `${msg.timestamp}-finish-${events.length}`,
                            type: "meta",
                            content: `Finish reason: ${choice.finish_reason}`,
                            raw,
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

    private parseResponsesRequest(msg: WsMessage, parsedJson: any): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, parsedJson);

        if (parsedJson.instructions) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-instructions`,
                type: "system_prompt",
                content: this.stringifyContent(parsedJson.instructions),
                raw: { instructions: parsedJson.instructions },
            });
        }

        const input = parsedJson.input;
        if (Array.isArray(input)) {
            input.forEach((item, index) => {
                events.push(
                    ...this.parseResponsesInputItem(msg, parsedJson, item, index),
                );
            });
        } else if (input != null) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-input`,
                type: "user_message",
                content: this.stringifyContent(input),
                raw: input,
            });
        }

        events.push({
            ...baseEvent,
            id: `${msg.timestamp}-responses-meta`,
            type: "meta",
            content: `Model: ${parsedJson.model}`,
            raw: { model: parsedJson.model },
        });

        return events;
    }

    private parseResponsesResponse(msg: WsMessage, parsedJson: any): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, parsedJson);

        (parsedJson.output || []).forEach((item: any, index: number) => {
            events.push(...this.parseResponsesOutputItem(msg, parsedJson, item, index));
        });

        if (parsedJson.status) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-status`,
                type: "meta",
                content: `Status: ${parsedJson.status}`,
                raw: { status: parsedJson.status },
            });
        }
        if (parsedJson.usage) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-usage`,
                type: "meta",
                content: `Usage: In ${parsedJson.usage.input_tokens || 0}, Out ${parsedJson.usage.output_tokens || 0}`,
                raw: { usage: parsedJson.usage },
            });
        }

        return events.length
            ? events
            : [
                  {
                      ...baseEvent,
                      type: "meta",
                      content: `Status: ${parsedJson.status || "unknown"}`,
                  },
              ];
    }

    private parseResponsesStream(msg: WsMessage): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];
        const baseEvent = this.baseEvent(msg, {
            stream: "openai.responses",
        });
        const contentParts: string[] = [];
        const contentDone: string[] = [];
        const reasoningParts: string[] = [];
        const reasoningDone: string[] = [];
        const textState = { chars: 0 };
        const toolCalls = new Map<
            string,
            { id?: string; name?: string; arguments: string; raw: any }
        >();
        const outputIndexToItemId = new Map<number, string>();
        const toolState = { chars: 0 };

        for (const data of this.parseSseDataLines(msg.text)) {
            if (typeof data.type !== "string" || !data.type.startsWith("response.")) {
                continue;
            }
            const raw = this.summarizeSseEvent(data);
            if (data.response?.usage) {
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-responses-usage`,
                    type: "meta",
                    content: `Usage: In ${data.response.usage.input_tokens || 0}, Out ${data.response.usage.output_tokens || 0}`,
                    raw,
                });
            }
            if (data.type === "response.output_text.delta" && data.delta) {
                const content = this.appendLimited(
                    contentParts,
                    data.delta,
                    textState,
                );
                if (!content) continue;
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-responses-content-${events.length}`,
                    type: "assistant_stream",
                    content,
                    raw,
                });
            } else if (
                data.type === "response.reasoning_summary_text.delta" &&
                data.delta
            ) {
                const reasoning = this.appendLimited(
                    reasoningParts,
                    data.delta,
                    textState,
                );
                if (!reasoning) continue;
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-responses-reasoning-${events.length}`,
                    type: "meta",
                    content: `[Reasoning Summary]\n${reasoning}`,
                    raw,
                });
            } else if (data.type === "response.content_part.done") {
                const part = data.part;
                if (part?.type === "output_text" && typeof part.text === "string") {
                    this.appendLimited(contentDone, part.text, textState);
                }
            } else if (data.type === "response.output_item.added") {
                const item = data.item;
                if (item?.type === "function_call") {
                    const key = item.id || item.call_id || String(data.output_index || 0);
                    if (typeof data.output_index === "number") {
                        outputIndexToItemId.set(data.output_index, key);
                    }
                    const current = toolCalls.get(key) || {
                        id: item.call_id,
                        name: item.name,
                        arguments: "",
                        raw,
                    };
                    current.id = item.call_id || current.id;
                    current.name = item.name || current.name;
                    toolCalls.set(key, current);
                }
            } else if (data.type === "response.output_item.done") {
                const item = data.item;
                if (item?.type === "reasoning") {
                    const summary = this.stringifyContent(item.summary);
                    if (summary) {
                        this.appendLimited(reasoningDone, summary, textState);
                    }
                } else if (item?.type === "function_call") {
                    const key = item.id || item.call_id || String(data.output_index || 0);
                    if (typeof data.output_index === "number") {
                        outputIndexToItemId.set(data.output_index, key);
                    }
                    const current = toolCalls.get(key) || {
                        id: item.call_id,
                        name: item.name,
                        arguments: "",
                        raw,
                    };
                    current.id = item.call_id || current.id;
                    current.name = item.name || current.name;
                    if (typeof item.arguments === "string") {
                        const parts: string[] = [];
                        this.appendLimited(parts, item.arguments, toolState);
                        current.arguments = parts.join("");
                    }
                    toolCalls.set(key, current);
                }
            } else if (data.type === "response.function_call_arguments.delta") {
                const key =
                    data.item_id ||
                    (typeof data.output_index === "number"
                        ? outputIndexToItemId.get(data.output_index)
                        : undefined) ||
                    String(data.output_index || 0);
                const current = toolCalls.get(key) || {
                    arguments: "",
                    raw,
                };
                const parts = [current.arguments];
                this.appendLimited(parts, data.delta || "", toolState);
                current.arguments = parts.join("");
                toolCalls.set(key, current);
            } else if (data.type === "response.function_call_arguments.done") {
                const key =
                    data.item_id ||
                    (typeof data.output_index === "number"
                        ? outputIndexToItemId.get(data.output_index)
                        : undefined) ||
                    String(data.output_index || 0);
                const current = toolCalls.get(key) || {
                    arguments: "",
                    raw,
                };
                if (typeof data.arguments === "string") {
                    const parts: string[] = [];
                    this.appendLimited(parts, data.arguments, toolState);
                    current.arguments = parts.join("");
                }
                toolCalls.set(key, current);
            } else if (data.type === "response.completed") {
                events.push({
                    ...baseEvent,
                    id: `${msg.timestamp}-responses-completed`,
                    type: "meta",
                    content: `Status: ${data.response?.status || "completed"}`,
                    raw,
                });
            }
        }

        if (reasoningParts.length === 0 && reasoningDone.length) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-reasoning-done`,
                type: "meta",
                content: `[Reasoning Summary]\n${reasoningDone.join("\n")}`,
                raw: { stream: "openai.responses", source: "reasoning_done" },
            });
        }
        if (contentParts.length === 0 && contentDone.length) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-content-done`,
                type: "assistant_stream",
                content: contentDone.join("\n"),
                raw: { stream: "openai.responses", source: "content_done" },
            });
        }
        for (const [key, toolCall] of toolCalls) {
            events.push({
                ...baseEvent,
                id: `${msg.timestamp}-responses-tool-${key}`,
                type: "tool_call",
                content: this.formatFunctionCall(
                    toolCall.name,
                    toolCall.arguments,
                    toolCall.id,
                ),
                raw: toolCall.raw,
            });
        }

        if (events.length === 0) {
            events.push({
                ...baseEvent,
                type: "unknown",
                content: "Could not extract response stream chunks.",
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
