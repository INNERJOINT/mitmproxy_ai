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
            // Attempt to parse SSE chunks
            const lines = msg.text.split("\n");
            let currentEventName = "";

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
                                id: `${msg.timestamp}-start-${Math.random()}`,
                                timestamp: msg.timestamp,
                                direction: "incoming",
                                provider: this.name,
                                type: "meta",
                                content: `Assistant stream started (Role: ${data.message?.role})`,
                                raw: data,
                            });
                        } else if (currentEventName === "content_block_delta") {
                            const delta = data.delta;
                            if (
                                delta &&
                                delta.type === "text_delta" &&
                                delta.text
                            ) {
                                events.push({
                                    id: `${msg.timestamp}-delta-${Math.random()}`,
                                    timestamp: msg.timestamp,
                                    direction: "incoming",
                                    provider: this.name,
                                    type: "assistant_stream",
                                    content: delta.text,
                                    raw: data,
                                });
                            } else if (
                                delta &&
                                delta.type === "thinking_delta" &&
                                delta.thinking
                            ) {
                                events.push({
                                    id: `${msg.timestamp}-think-${Math.random()}`,
                                    timestamp: msg.timestamp,
                                    direction: "incoming",
                                    provider: this.name,
                                    type: "meta",
                                    content: `[Thinking...]\n${delta.thinking}`,
                                    raw: data,
                                });
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
