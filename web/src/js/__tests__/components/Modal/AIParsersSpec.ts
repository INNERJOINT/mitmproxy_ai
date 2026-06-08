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

    it("parses OpenAI responses requests", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: true,
            text: JSON.stringify({
                model: "gpt-5.5",
                instructions: "Be concise.",
                input: [
                    {
                        type: "message",
                        role: "developer",
                        content: [{ type: "input_text", text: "Use tools." }],
                    },
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "Hello responses" }],
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "tool output",
                    },
                ],
                stream: true,
            }),
        });

        expect(events.map((event) => event.provider)).toContain("OpenAI API");
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "system_prompt",
                content: "Be concise.",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "system_prompt",
                content: "Use tools.",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "user_message",
                content: "Hello responses",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "tool_result",
                content: "[Tool Result: call_1]\ntool output",
            }),
        );
    });

    it("parses OpenAI responses streams", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: false,
            text:
                'data: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"in_progress"}}\n\n' +
                'data: {"type":"response.reasoning_summary_text.delta","delta":"Need","item_id":"rs_1","output_index":0,"summary_index":0}\n\n' +
                'data: {"type":"response.output_text.delta","content_index":0,"delta":"Done","item_id":"msg_1","output_index":1}\n\n' +
                'data: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","status":"in_progress","name":"Agent","call_id":"call_2","arguments":""}}\n\n' +
                'data: {"type":"response.function_call_arguments.done","output_index":2,"arguments":"{\\"subagent_type\\":\\"Explore\\"}"}\n\n' +
                'data: {"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","status":"completed","name":"Agent","call_id":"call_2","arguments":"{\\"subagent_type\\":\\"Explore\\"}"}}\n\n' +
                'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"completed","usage":{"input_tokens":12,"output_tokens":7}}}\n\n',
        });

        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "meta",
                content: "[Reasoning Summary]\nNeed",
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "assistant_stream",
                content: "Done",
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
                content: "Usage: In 12, Out 7",
            }),
        );
    });

    it("parses OpenAI responses done-only content streams", () => {
        const events = parseSingleWsMessage({
            timestamp,
            from_client: false,
            text:
                'data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_1","output_index":1,"part":{"type":"output_text","text":"Final only"}}\n\n' +
                'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"completed"}}\n\n',
        });

        expect(events).toContainEqual(
            expect.objectContaining({
                provider: "OpenAI API",
                type: "assistant_stream",
                content: "Final only",
            }),
        );
    });
});
