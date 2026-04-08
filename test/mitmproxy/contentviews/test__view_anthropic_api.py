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


def test_render_priority_not_anthropic():
    assert 0 == anthropic_api.render_priority(
        b'{"model": "gpt-4", "messages": []}',
        Metadata(content_type="application/json"),
    )
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
