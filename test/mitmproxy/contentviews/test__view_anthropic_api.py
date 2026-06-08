import json

import pytest

from mitmproxy.contentviews import Metadata
from mitmproxy.contentviews._view_anthropic_api import anthropic_api

ANTHROPIC_REQUEST = json.dumps({
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
        {"role": "user", "content": [{"type": "text", "text": "How are you?"}]},
    ],
}).encode()

ANTHROPIC_RESPONSE_JSON = json.dumps({
    "id": "msg_123",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-4-20250514",
    "content": [
        {"type": "thinking", "thinking": "Let me think..."},
        {"type": "text", "text": "I'm doing well!"},
    ],
    "usage": {"input_tokens": 100, "output_tokens": 50},
}).encode()

ANTHROPIC_SSE = (
    "event: message_start\n"
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message",'
    '"role":"assistant","model":"claude-sonnet-4-20250514","usage":{"input_tokens":25}}}\n\n'
    "event: content_block_start\n"
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    "event: content_block_delta\n"
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
    "event: content_block_delta\n"
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world!"}}\n\n'
    "event: content_block_stop\n"
    'data: {"type":"content_block_stop","index":0}\n\n'
    "event: message_delta\n"
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n'
).encode()

OPENAI_REQUEST = json.dumps({
    "model": "gpt-4.1",
    "stream": True,
    "messages": [
        {"role": "system", "content": "You are concise."},
        {"role": "user", "content": [{"type": "text", "text": "Hello"}]},
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "Need a tool.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "Read",
                        "arguments": '{"file_path":"/tmp/a"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "file contents"},
    ],
    "tools": [
        {
            "type": "function",
            "function": {"name": "Read", "description": "Read a file"},
        }
    ],
}).encode()

OPENAI_RESPONSE_JSON = json.dumps({
    "id": "chatcmpl_1",
    "object": "chat.completion",
    "model": "gpt-4.1",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Done",
                "tool_calls": [
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {
                            "name": "Agent",
                            "arguments": '{"subagent_type":"Explore"}',
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}).encode()

OPENAI_SSE = (
    'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",'
    '"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Think"},'
    '"finish_reason":null}],"usage":null}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",'
    '"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",'
    '"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_3",'
    '"type":"function","function":{"name":"Agent","arguments":""}}]},"finish_reason":null}],"usage":null}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",'
    '"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"subagent_type\\":"}}]},'
    '"finish_reason":null}],"usage":null}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","model":"gpt-4.1",'
    '"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Explore\\"}"}}]},'
    '"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
    "data: [DONE]\n\n"
).encode()

OPENAI_RESPONSES_REQUEST = json.dumps({
    "model": "gpt-5.5",
    "instructions": "Be concise.",
    "input": [
        {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": "Use the tools."}],
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "Hello responses"}],
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "tool output",
        },
    ],
    "tools": [
        {
            "type": "function",
            "name": "Read",
            "description": "Read a file",
            "parameters": {"type": "object"},
        }
    ],
    "stream": True,
    "parallel_tool_calls": True,
    "reasoning": {"effort": "medium", "summary": "detailed"},
}).encode()

OPENAI_RESPONSES_RESPONSE_JSON = json.dumps({
    "id": "resp_1",
    "object": "response",
    "model": "gpt-5.5",
    "status": "completed",
    "output": [
        {
            "id": "rs_1",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Need a tool."}],
        },
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Done"}],
        },
        {
            "id": "fc_1",
            "type": "function_call",
            "name": "Agent",
            "call_id": "call_2",
            "arguments": '{"subagent_type":"Explore"}',
        },
    ],
    "usage": {"input_tokens": 12, "output_tokens": 7},
}).encode()

OPENAI_RESPONSES_SSE = (
    'data: {"type":"response.created","response":{"id":"resp_1",'
    '"object":"response","model":"gpt-5.5","status":"in_progress"},'
    '"sequence_number":0}\n\n'
    'data: {"type":"response.reasoning_summary_text.delta","delta":"Need",'
    '"item_id":"rs_1","output_index":0,"summary_index":0}\n\n'
    'data: {"type":"response.reasoning_summary_text.delta","delta":" a tool.",'
    '"item_id":"rs_1","output_index":0,"summary_index":0}\n\n'
    'data: {"type":"response.output_text.delta","content_index":0,"delta":"Done",'
    '"item_id":"msg_1","output_index":1}\n\n'
    'data: {"type":"response.output_item.added","output_index":2,'
    '"item":{"id":"fc_1","type":"function_call","status":"in_progress",'
    '"name":"Agent","call_id":"call_2","arguments":""}}\n\n'
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1",'
    '"output_index":2,"delta":"{\\"subagent_type\\":"}\n\n'
    'data: {"type":"response.function_call_arguments.done","item_id":"fc_1",'
    '"output_index":2,"arguments":"{\\"subagent_type\\":\\"Explore\\"}"}\n\n'
    'data: {"type":"response.output_item.done","output_index":2,'
    '"item":{"id":"fc_1","type":"function_call","status":"completed",'
    '"name":"Agent","call_id":"call_2",'
    '"arguments":"{\\"subagent_type\\":\\"Explore\\"}"}}\n\n'
    'data: {"type":"response.completed","response":{"id":"resp_1",'
    '"object":"response","model":"gpt-5.5","status":"completed",'
    '"usage":{"input_tokens":12,"output_tokens":7}}}\n\n'
).encode()


def test_render_priority_request():
    assert 2 == anthropic_api.render_priority(
        ANTHROPIC_REQUEST, Metadata(content_type="application/json")
    )


def test_render_priority_response_json():
    assert 2 == anthropic_api.render_priority(
        ANTHROPIC_RESPONSE_JSON, Metadata(content_type="application/json")
    )


def test_render_priority_sse():
    assert 2 == anthropic_api.render_priority(
        ANTHROPIC_SSE, Metadata(content_type="text/event-stream")
    )


def test_render_priority_openai_request():
    assert 2 == anthropic_api.render_priority(
        OPENAI_REQUEST, Metadata(content_type="application/json")
    )


def test_render_priority_openai_response_json():
    assert 2 == anthropic_api.render_priority(
        OPENAI_RESPONSE_JSON, Metadata(content_type="application/json")
    )


def test_render_priority_openai_sse():
    assert 2 == anthropic_api.render_priority(
        OPENAI_SSE, Metadata(content_type="text/event-stream")
    )


def test_render_priority_openai_responses_request():
    assert 2 == anthropic_api.render_priority(
        OPENAI_RESPONSES_REQUEST, Metadata(content_type="application/json")
    )


def test_render_priority_openai_responses_response_json():
    assert 2 == anthropic_api.render_priority(
        OPENAI_RESPONSES_RESPONSE_JSON, Metadata(content_type="application/json")
    )


def test_render_priority_openai_responses_sse():
    assert 2 == anthropic_api.render_priority(
        OPENAI_RESPONSES_SSE, Metadata(content_type="text/event-stream")
    )


def test_render_priority_not_llm_api():
    assert 0 == anthropic_api.render_priority(
        b'{"key": "value"}', Metadata(content_type="application/json")
    )
    assert 0 == anthropic_api.render_priority(b"", Metadata())


def test_prettify_request():
    result = anthropic_api.prettify(ANTHROPIC_REQUEST, Metadata())
    assert "Anthropic API Request" in result
    assert "claude-sonnet-4-20250514" in result
    assert "System Prompt" in result
    assert "You are a helpful assistant." in result
    assert "[USER]" in result
    assert "Hello" in result


def test_prettify_response_json():
    result = anthropic_api.prettify(ANTHROPIC_RESPONSE_JSON, Metadata())
    assert "Anthropic API Response" in result
    assert "[Thinking]" in result
    assert "I'm doing well!" in result
    assert "100 in / 50 out" in result


def test_prettify_sse():
    result = anthropic_api.prettify(ANTHROPIC_SSE, Metadata())
    assert "Anthropic API Stream" in result
    assert "Hello world!" in result
    assert "Output Tokens: 12" in result


def test_prettify_openai_request():
    result = anthropic_api.prettify(OPENAI_REQUEST, Metadata())
    assert "OpenAI Chat Completions Request" in result
    assert "gpt-4.1" in result
    assert "[Reasoning]" in result
    assert "Need a tool." in result
    assert "[Tool Call: Read]" in result
    assert '"file_path": "/tmp/a"' in result
    assert "[Tool Result: call_1]" in result
    assert "Read a file" in result


def test_prettify_openai_response_json():
    result = anthropic_api.prettify(OPENAI_RESPONSE_JSON, Metadata())
    assert "OpenAI Chat Completions Response" in result
    assert "10 in / 5 out" in result
    assert "Done" in result
    assert "[Tool Call: Agent]" in result
    assert '"subagent_type": "Explore"' in result
    assert "[Finish Reason: tool_calls]" in result


def test_prettify_openai_sse():
    result = anthropic_api.prettify(OPENAI_SSE, Metadata())
    assert "OpenAI Chat Completions Stream" in result
    assert "10 in / 5 out" in result
    assert "[Reasoning]" in result
    assert "Think" in result
    assert "Hi" in result
    assert "[Tool Call: Agent]" in result
    assert '"subagent_type": "Explore"' in result
    assert "[Finish Reason: tool_calls]" in result


def test_prettify_openai_responses_request():
    result = anthropic_api.prettify(OPENAI_RESPONSES_REQUEST, Metadata())
    assert "OpenAI Responses Request" in result
    assert "gpt-5.5" in result
    assert "Be concise." in result
    assert "Use the tools." in result
    assert "Hello responses" in result
    assert "[Tool Result: call_1]" in result
    assert "Read a file" in result
    assert "Reasoning: effort: medium, summary: detailed" in result


def test_prettify_openai_responses_response_json():
    result = anthropic_api.prettify(OPENAI_RESPONSES_RESPONSE_JSON, Metadata())
    assert "OpenAI Responses Response" in result
    assert "12 in / 7 out" in result
    assert "[Reasoning Summary]" in result
    assert "Need a tool." in result
    assert "Done" in result
    assert "[Tool Call: Agent]" in result
    assert '"subagent_type": "Explore"' in result


def test_prettify_openai_responses_sse():
    result = anthropic_api.prettify(OPENAI_RESPONSES_SSE, Metadata())
    assert "OpenAI Responses Stream" in result
    assert "12 in / 7 out" in result
    assert "[Reasoning Summary]" in result
    assert "Need a tool." in result
    assert "Done" in result
    assert "[Tool Call: Agent]" in result
    assert '"subagent_type": "Explore"' in result


def test_prettify_invalid():
    with pytest.raises((ValueError, Exception)):
        anthropic_api.prettify(b'"just a string"', Metadata())


def test_prettify_request_with_tools():
    data = json.dumps({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Use the tool"}],
        "tools": [{"name": "get_weather", "description": "Get weather info"}],
    }).encode()
    result = anthropic_api.prettify(data, Metadata())
    assert "get_weather" in result
    assert "Tools" in result
