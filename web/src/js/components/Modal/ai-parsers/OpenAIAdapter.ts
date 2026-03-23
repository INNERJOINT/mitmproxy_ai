import type { AIAnalyzerEvent, AIProtocolParser, WsMessage } from "./types";

export class OpenAIAdapter implements AIProtocolParser {
    name = "OpenAI Realtime API";

    canParse(msg: WsMessage, parsedJson?: any): boolean {
        // We detect OpenAI Realtime events typically by having a `type` string like "session.update", "response.create", etc.
        // Or "codex.rate_limits" for codex specific WS messages.
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
        const events: AIAnalyzerEvent[] = [];
        const direction: "outgoing" | "incoming" = msg.from_client
            ? "outgoing"
            : "incoming";
        const baseEvent = {
            id: `${msg.timestamp}-${Math.random()}`,
            timestamp: msg.timestamp,
            direction,
            provider: this.name,
            raw: parsedJson || msg.text,
        };

        if (!parsedJson) {
            return [{ ...baseEvent, type: "unknown" as const }];
        }

        const type = parsedJson.type;

        if (type === "response.create") {
            // Usually contains instructions/system prompt in Realtime API
            if (parsedJson.instructions) {
                events.push({
                    ...baseEvent,
                    type: "system_prompt",
                    content: parsedJson.instructions,
                });
            } else if (parsedJson.response?.instructions) {
                // Sometime the payload structure might nest under response
                events.push({
                    ...baseEvent,
                    type: "system_prompt",
                    content: parsedJson.response.instructions,
                });
            }

            // Extract user prompts from input array
            const inputArr = parsedJson.input || parsedJson.response?.input;
            if (Array.isArray(inputArr)) {
                for (const item of inputArr) {
                    if (item.role === "user" && Array.isArray(item.content)) {
                        const textContent = item.content.find(
                            (c: any) =>
                                c.type === "input_text" || c.type === "text",
                        )?.text;
                        if (textContent) {
                            events.push({
                                ...baseEvent,
                                type: "user_message",
                                content: textContent,
                            });
                        } else {
                            events.push({
                                ...baseEvent,
                                type: "user_message",
                                content: "<Media/Audio Input>",
                            });
                        }
                    }
                }
            }

            if (events.length === 0) {
                events.push({
                    ...baseEvent,
                    type: "user_message", // Triggers generation
                    content: "<Trigger Response>",
                });
            }
        } else if (type === "conversation.item.create") {
            const item = parsedJson.item;
            if (item && item.role === "user" && Array.isArray(item.content)) {
                const textContent = item.content.find(
                    (c: any) => c.type === "input_text" || c.type === "text",
                )?.text;
                if (textContent) {
                    events.push({
                        ...baseEvent,
                        type: "user_message",
                        content: textContent,
                    });
                } else {
                    events.push({
                        ...baseEvent,
                        type: "user_message",
                        content: `<Media/Audio Input>`,
                    });
                }
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
                content: `Response Complete`,
            });
        } else if (type === "codex.rate_limits") {
            events.push({
                ...baseEvent,
                type: "meta",
                content: `Rate Limits Info`,
            });
        } else {
            // Default unmapped known event
            events.push({
                ...baseEvent,
                type: "unknown",
            });
        }

        return events;
    }
}
