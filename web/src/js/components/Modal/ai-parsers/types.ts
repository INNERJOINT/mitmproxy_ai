// Interface for API response message format
export interface WsMessage {
    text: string;
    from_client: boolean;
    timestamp: number;
}

// Represents a standardized AI event ready for UI rendering
export interface AIAnalyzerEvent {
    id: string; // Unique ID (e.g., flow ID + message timestamp + index)
    timestamp: number;
    direction: "incoming" | "outgoing";
    provider: string; // Name of the parsed protocol (e.g., "OpenAI Realtime", "Unknown")
    type: 
        | "system_prompt" 
        | "user_message" 
        | "assistant_stream" 
        | "tool_call" 
        | "tool_result" 
        | "meta" 
        | "unknown";
    content?: string; // Text to display
    raw: any; // The original JSON or text
}

// Interface for protocol parsers
export interface AIProtocolParser {
    name: string;
    
    // Quick check if this parser can understand the given message
    canParse(msg: WsMessage, parsedJson?: any): boolean;
    
    // Converts the raw message into a standard AIAnalyzerEvent array
    parse(msg: WsMessage, parsedJson?: any): AIAnalyzerEvent[];
}
