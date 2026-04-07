import type { AIAnalyzerEvent, AIProtocolParser, WsMessage } from "./types";

export class AnthropicAdapter implements AIProtocolParser {
    name = "Anthropic API";

    canParse(msg: WsMessage, parsedJson?: any): boolean {
        if (msg.from_client && parsedJson) {
            // Check for typical Anthropic Request
            if (parsedJson.model && Array.isArray(parsedJson.messages)) {
                return true;
            }
        } else if (!msg.from_client) {
            // Check for typical Anthropic SSE Stream
            if (
                msg.text &&
                (msg.text.includes("event: message_start") ||
                    msg.text.includes("event: content_block_delta"))
            ) {
                return true;
            }
        }
        return false;
    }

    parse(msg: WsMessage, parsedJson?: any): AIAnalyzerEvent[] {
        const events: AIAnalyzerEvent[] = [];

        if (msg.from_client && parsedJson) {
            // It's a Request
            const messages = parsedJson.messages;
            if (Array.isArray(messages)) {
                messages.forEach((m: any, idx: number) => {
                    if (m.role === "user") {
                        let content = "";
                        if (Array.isArray(m.content)) {
                            // Claude system prompt reminder or text bits
                            content = m.content
                                .map((c: any) => c.text || JSON.stringify(c))
                                .join("\n");
                        } else {
                            content =
                                typeof m.content === "string"
                                    ? m.content
                                    : JSON.stringify(m.content);
                        }

                        // Anthropic often puts <system-reminder> inside user messages for CLI tools
                        if (content.includes("<system-reminder>")) {
                            events.push({
                                id: `${msg.timestamp}-sys-${idx}`,
                                timestamp: msg.timestamp,
                                direction: "outgoing",
                                provider: this.name,
                                type: "system_prompt",
                                content: content,
                                raw: m,
                            });
                        } else {
                            events.push({
                                id: `${msg.timestamp}-user-${idx}`,
                                timestamp: msg.timestamp,
                                direction: "outgoing",
                                provider: this.name,
                                type: "user_message",
                                content: content,
                                raw: m,
                            });
                        }
                    } else if (m.role === "assistant") {
                        events.push({
                            id: `${msg.timestamp}-ast-${idx}`,
                            timestamp: msg.timestamp,
                            direction: "outgoing",
                            provider: this.name,
                            type: "assistant_stream",
                            content: Array.isArray(m.content)
                                ? m.content
                                      .map(
                                          (c: any) =>
                                              c.text || c.thinking || "",
                                      )
                                      .join("\n")
                                : m.content,
                            raw: m,
                        });
                    }
                });
            }

            if (parsedJson.system) {
                events.push({
                    id: `${msg.timestamp}-sys-top`,
                    timestamp: msg.timestamp,
                    direction: "outgoing",
                    provider: this.name,
                    type: "system_prompt",
                    content:
                        typeof parsedJson.system === "string"
                            ? parsedJson.system
                            : JSON.stringify(parsedJson.system, null, 2),
                    raw: parsedJson.system,
                });
            }

            events.push({
                id: `${msg.timestamp}-meta`,
                timestamp: msg.timestamp,
                direction: "outgoing",
                provider: this.name,
                type: "meta",
                content: `Model: ${parsedJson.model}`,
                raw: { model: parsedJson.model },
            });

            return events;
        }

        if (!msg.from_client) {
            // Attempt to parse SSE chunks with content block grouping
            const lines = msg.text.split("\n");
            let currentEventName = "";

            // Track content blocks: index -> { type, content, rawEvents }
            const contentBlocks = new Map<
                number,
                {
                    type: string;
                    content: string;
                    rawEvents: any[];
                }
            >();

            for (const line of lines) {
                if (line.startsWith("event: ")) {
                    currentEventName = line.substring(7).trim();
                } else if (line.startsWith("data: ")) {
                    const dataStr = line.substring(6).trim();
                    if (!dataStr || dataStr === "[DONE]") continue;

                    try {
                        const data = JSON.parse(dataStr);

                        if (currentEventName === "message_start") {
                            events.push({
                                id: `${msg.timestamp}-start`,
                                timestamp: msg.timestamp,
                                direction: "incoming",
                                provider: this.name,
                                type: "meta",
                                content: `Assistant stream started (Role: ${data.message?.role})`,
                                raw: data,
                            });
                        } else if (currentEventName === "content_block_start") {
                            const block = data.content_block;
                            const index = data.index;
                            if (block) {
                                contentBlocks.set(index, {
                                    type: block.type,
                                    content: block.thinking || block.text || "",
                                    rawEvents: [data],
                                });
                            }
                        } else if (currentEventName === "content_block_delta") {
                            const delta = data.delta;
                            const index = data.index;
                            const block = contentBlocks.get(index);

                            if (block) {
                                block.rawEvents.push(data);
                                if (delta?.type === "thinking_delta") {
                                    block.content += delta.thinking || "";
                                } else if (delta?.type === "text_delta") {
                                    block.content += delta.text || "";
                                } else if (delta?.type === "input_json_delta") {
                                    block.content += delta.partial_json || "";
                                }
                            }
                        } else if (currentEventName === "content_block_stop") {
                            const index = data.index;
                            const block = contentBlocks.get(index);

                            if (block) {
                                block.rawEvents.push(data);

                                // Emit the complete block as a single event
                                if (block.type === "thinking") {
                                    events.push({
                                        id: `${msg.timestamp}-thinking-${index}`,
                                        timestamp: msg.timestamp,
                                        direction: "incoming",
                                        provider: this.name,
                                        type: "meta",
                                        content: `[Thinking]\n${block.content}`,
                                        raw: block.rawEvents,
                                    });
                                } else if (block.type === "text") {
                                    events.push({
                                        id: `${msg.timestamp}-text-${index}`,
                                        timestamp: msg.timestamp,
                                        direction: "incoming",
                                        provider: this.name,
                                        type: "assistant_stream",
                                        content: block.content,
                                        raw: block.rawEvents,
                                    });
                                } else if (block.type === "tool_use") {
                                    // Extract tool name from the first event
                                    const startEvent = block.rawEvents[0];
                                    const toolName =
                                        startEvent?.content_block?.name ||
                                        "unknown";
                                    events.push({
                                        id: `${msg.timestamp}-tool-${index}`,
                                        timestamp: msg.timestamp,
                                        direction: "incoming",
                                        provider: this.name,
                                        type: "tool_call",
                                        content: `[Tool: ${toolName}]\n${block.content}`,
                                        raw: block.rawEvents,
                                    });
                                }

                                contentBlocks.delete(index);
                            }
                        } else if (currentEventName === "message_delta") {
                            if (data.usage) {
                                events.push({
                                    id: `${msg.timestamp}-usage`,
                                    timestamp: msg.timestamp,
                                    direction: "incoming",
                                    provider: this.name,
                                    type: "meta",
                                    content: `Usage: In ${data.usage.input_tokens || 0}, Out ${data.usage.output_tokens || 0}`,
                                    raw: data,
                                });
                            }
                        }
                    } catch {
                        // ignore unparseable data line
                    }
                }
            }

            if (events.length === 0) {
                // If we couldn't parse SSE chunks, fallback
                events.push({
                    id: `${msg.timestamp}-raw`,
                    timestamp: msg.timestamp,
                    direction: "incoming",
                    provider: this.name,
                    type: "unknown",
                    content: "Could not extract stream chunks.",
                    raw: msg.text,
                });
            }

            return events;
        }

        return [];
    }
}
