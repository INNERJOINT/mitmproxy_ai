import { parseSingleWsMessage } from "../../../components/Modal/ai-parsers";

const timestamp = 1780908400;

describe("AI protocol parsers", () => {
    it("keeps Anthropic requests on the Anthropic parser", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: true,
            text: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                system: "You are helpful.",
                messages: [{ role: "user", content: "Hello" }],
            }),
        });

        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "Anthropic API",
                type: "system_prompt",
                content: "You are helpful.",
            }),
        );
        expect(events.map((event) => event.provider)).not.toContain("OpenAI API");
    });

    it("parses OpenAI chat completions requests", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: true,
            text: JSON.stringify({
                model: "gpt-4.1",
                messages: [
                    { role: "system", content: "You are concise." },
                    { role: "user", content: [{ type: "text", text: "Hello" }] },
                    {
                        role: "assistant",
                        content: "",
                        reasoning_content: "Need a tool.",
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "Read",
                                    arguments: '{"file_path":"/tmp/a"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_1",
                        content: "file contents",
                    },
                ],
            }),
        });

        expect(events.map((event) => event.provider)).toContain("OpenAI API");
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "system_prompt",
                content: "You are concise.",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({ type: "user_message", content: "Hello" }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "assistant_stream",
                content: "[Reasoning]\nNeed a tool.",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "tool_call",
                content: expect.stringContaining("[Tool: Read]"),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "tool_result",
                content: "[Tool Result: call_1]\nfile contents",
            }),
        );
    });

    it("parses OpenAI chat completions streams", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: false,
            text:
                'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",' +
                '"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}\n\n' +
                'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",' +
                '"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2",' +
                '"type":"function","function":{"name":"Agent","arguments":"{\\"subagent_type\\":\\"Explore\\"}"}}]},' +
                '"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
                "data: [DONE]\n\n",
        });

        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "assistant_stream",
                content: "Hi",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "tool_call",
                content: expect.stringContaining("[Tool: Agent]"),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "meta",
                content: "Usage: In 10, Out 5",
            }),
        );
    });
});
