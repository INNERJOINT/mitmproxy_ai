import json

from mitmproxy.contentviews._api import Contentview
from mitmproxy.contentviews._api import Metadata


def _is_anthropic_request(data: dict) -> bool:
    """Check if JSON data looks like an Anthropic API request."""
    return (
        isinstance(data.get("model"), str)
        and isinstance(data.get("messages"), list)
        and str(data.get("model", "")).startswith("claude")
    )


def _is_anthropic_response(data: dict) -> bool:
    """Check if JSON data looks like a non-streaming Anthropic API response."""
    return (
        data.get("type") == "message"
        and isinstance(data.get("content"), list)
        and isinstance(data.get("model"), str)
        and str(data.get("model", "")).startswith("claude")
    )


def _is_anthropic_sse(text: str) -> bool:
    """Check if text looks like an Anthropic SSE stream."""
    return "event: message_start" in text or "event: content_block_delta" in text


def _format_request(data: dict) -> str:
    """Format an Anthropic API request into readable text."""
    lines: list[str] = []
    lines.append(f"[Anthropic API Request]  Model: {data.get('model', 'unknown')}")

    if max_tokens := data.get("max_tokens"):
        lines[-1] += f"  Max Tokens: {max_tokens}"
    if temperature := data.get("temperature"):
        lines[-1] += f"  Temperature: {temperature}"

    lines.append("")

    # System prompt
    if system := data.get("system"):
        lines.append("--- System Prompt ---")
        if isinstance(system, str):
            lines.append(system)
        elif isinstance(system, list):
            for block in system:
                lines.append(block.get("text", json.dumps(block, ensure_ascii=False)))
        else:
            lines.append(json.dumps(system, indent=2, ensure_ascii=False))
        lines.append("")

    # Messages
    for i, msg in enumerate(data.get("messages", [])):
        role = msg.get("role", "unknown").upper()
        lines.append(f"--- [{role}] ---")
        content = msg.get("content")
        if isinstance(content, str):
            lines.append(content)
        elif isinstance(content, list):
            for block in content:
                btype = block.get("type", "")
                if btype == "text":
                    lines.append(block.get("text", ""))
                elif btype == "tool_use":
                    name = block.get("name", "unknown")
                    inp = json.dumps(block.get("input", {}), indent=2, ensure_ascii=False)
                    lines.append(f"[Tool Call: {name}]\n{inp}")
                elif btype == "tool_result":
                    tool_id = block.get("tool_use_id", "")
                    result_content = block.get("content", "")
                    if isinstance(result_content, list):
                        result_content = "\n".join(
                            b.get("text", json.dumps(b, ensure_ascii=False))
                            for b in result_content
                        )
                    lines.append(f"[Tool Result: {tool_id}]\n{result_content}")
                elif btype == "thinking":
                    lines.append(f"[Thinking]\n{block.get('thinking', '')}")
                else:
                    lines.append(json.dumps(block, indent=2, ensure_ascii=False))
        lines.append("")

    # Tools definition
    if tools := data.get("tools"):
        lines.append("--- Tools ---")
        for tool in tools:
            lines.append(f"  - {tool.get('name', 'unknown')}: {tool.get('description', '')}")
        lines.append("")

    return "\n".join(lines)


def _format_response_json(data: dict) -> str:
    """Format a non-streaming Anthropic API response."""
    lines: list[str] = []
    role = data.get("role", "assistant").upper()
    model = data.get("model", "unknown")
    lines.append(f"[Anthropic API Response]  Model: {model}  Role: {role}")

    if usage := data.get("usage"):
        inp = usage.get("input_tokens", 0)
        out = usage.get("output_tokens", 0)
        lines[-1] += f"  Tokens: {inp} in / {out} out"

    lines.append("")

    for block in data.get("content", []):
        btype = block.get("type", "")
        if btype == "text":
            lines.append(block.get("text", ""))
        elif btype == "thinking":
            lines.append(f"[Thinking]\n{block.get('thinking', '')}")
        elif btype == "tool_use":
            name = block.get("name", "unknown")
            inp = json.dumps(block.get("input", {}), indent=2, ensure_ascii=False)
            lines.append(f"[Tool Call: {name}]\n{inp}")
        else:
            lines.append(json.dumps(block, indent=2, ensure_ascii=False))
        lines.append("")

    return "\n".join(lines)


def _format_sse(text: str) -> str:
    """Parse Anthropic SSE stream and format into readable text."""
    lines: list[str] = []
    current_event = ""

    # Track content blocks: index -> {type, content}
    content_blocks: dict[int, dict] = {}

    for line in text.split("\n"):
        if line.startswith("event: "):
            current_event = line[7:].strip()
        elif line.startswith("data: "):
            data_str = line[6:].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                data = json.loads(data_str)
            except (json.JSONDecodeError, ValueError):
                continue

            if current_event == "message_start":
                msg = data.get("message", {})
                model = msg.get("model", "unknown")
                role = msg.get("role", "assistant")
                lines.append(f"[Anthropic API Stream]  Model: {model}  Role: {role}")
                if usage := msg.get("usage"):
                    lines[-1] += f"  Input Tokens: {usage.get('input_tokens', 0)}"
                lines.append("")

            elif current_event == "content_block_start":
                block = data.get("content_block", {})
                index = data.get("index", 0)
                content_blocks[index] = {
                    "type": block.get("type", ""),
                    "content": block.get("thinking", "") or block.get("text", ""),
                    "name": block.get("name", ""),
                }

            elif current_event == "content_block_delta":
                delta = data.get("delta", {})
                index = data.get("index", 0)
                block = content_blocks.get(index)
                if block:
                    dtype = delta.get("type", "")
                    if dtype == "thinking_delta":
                        block["content"] += delta.get("thinking", "")
                    elif dtype == "text_delta":
                        block["content"] += delta.get("text", "")
                    elif dtype == "input_json_delta":
                        block["content"] += delta.get("partial_json", "")

            elif current_event == "content_block_stop":
                index = data.get("index", 0)
                block = content_blocks.pop(index, None)
                if block:
                    btype = block["type"]
                    if btype == "thinking":
                        lines.append(f"[Thinking]\n{block['content']}\n")
                    elif btype == "text":
                        lines.append(f"{block['content']}\n")
                    elif btype == "tool_use":
                        name = block.get("name", "unknown")
                        lines.append(f"[Tool Call: {name}]\n{block['content']}\n")

            elif current_event == "message_delta":
                if usage := data.get("usage"):
                    lines.append(
                        f"[Usage]  Output Tokens: {usage.get('output_tokens', 0)}"
                    )
                if data.get("delta", {}).get("stop_reason"):
                    lines.append(
                        f"[Stop Reason: {data['delta']['stop_reason']}]"
                    )

    if not lines:
        raise ValueError("Not a valid Anthropic SSE stream.")

    return "\n".join(lines)


class AnthropicApiContentview(Contentview):
    name = "Anthropic API"
    syntax_highlight = "yaml"

    def prettify(self, data: bytes, metadata: Metadata) -> str:
        text = data.decode("utf-8", errors="replace")

        # Try SSE stream first
        if _is_anthropic_sse(text):
            return _format_sse(text)

        # Try JSON (request or non-streaming response)
        parsed = json.loads(data)
        if _is_anthropic_request(parsed):
            return _format_request(parsed)
        if _is_anthropic_response(parsed):
            return _format_response_json(parsed)

        raise ValueError("Not an Anthropic API message.")

    def render_priority(self, data: bytes, metadata: Metadata) -> float:
        if not data:
            return 0

        text = data.decode("utf-8", errors="replace")

        # SSE stream detection
        if metadata.content_type == "text/event-stream" and _is_anthropic_sse(text):
            return 2

        # JSON detection
        if metadata.content_type in ("application/json",):
            try:
                parsed = json.loads(data)
                if _is_anthropic_request(parsed) or _is_anthropic_response(parsed):
                    return 2
            except (json.JSONDecodeError, ValueError):
                pass

        return 0


anthropic_api = AnthropicApiContentview()
