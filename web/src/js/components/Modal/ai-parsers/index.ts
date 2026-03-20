import type { AIAnalyzerEvent, AIProtocolParser, WsMessage } from "./types";
import { OpenAIAdapter } from "./OpenAIAdapter";
import { AnthropicAdapter } from "./AnthropicAdapter";

// The Registry of all available AI API Parsers
const parsers: AIProtocolParser[] = [
    new OpenAIAdapter(),
    new AnthropicAdapter(),
];

export function parseSingleWsMessage(msg: WsMessage): AIAnalyzerEvent[] {
    let parsedJson = null;
    try {
        parsedJson = JSON.parse(msg.text);
    } catch {
        // Not valid JSON, handled by fallback
    }

    const matchedParser = parsers.find((p) => p.canParse(msg, parsedJson));

    if (matchedParser) {
        return matchedParser.parse(msg, parsedJson);
    } else {
        // Fallback for completely unrecognized messages
        return [{
            id: `${msg.timestamp}-${Math.random()}`,
            timestamp: msg.timestamp,
            direction: msg.from_client ? "outgoing" : "incoming",
            provider: "Unknown",
            type: "unknown",
            raw: parsedJson || msg.text,
        }];
    }
}

export function parseAIProtocolMessages(rawMessages: WsMessage[]): AIAnalyzerEvent[] {
    const results: AIAnalyzerEvent[] = [];
    for (const msg of rawMessages) {
        results.push(...parseSingleWsMessage(msg));
    }
    // Sort chronologically just in case
    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
}
