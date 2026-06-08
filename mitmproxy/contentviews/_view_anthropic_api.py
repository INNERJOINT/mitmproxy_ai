import json
from collections.abc import Iterable

from mitmproxy.contentviews._api import Contentview
from mitmproxy.contentviews._api import Metadata


def _is_anthropic_request(data: dict) -> bool:
    return (
        isinstance(data.get("model"), str)
        and isinstance(data.get("messages"), list)
        and str(data.get("model", "")).startswith("claude")
    )


def _is_anthropic_response(data: dict) -> bool:
    return (
        data.get("type") == "message"
        and isinstance(data.get("content"), list)
        and isinstance(data.get("model"), str)
        and str(data.get("model", "")).startswith("claude")
    )


def _is_anthropic_sse(text: str) -> bool:
    return "event: message_start" in text or "event: content_block_delta" in text


def _is_openai_chat_request(data: dict) -> bool:
    return isinstance(data.get("model"), str) and isinstance(data.get("messages"), list)


def _is_openai_chat_response(data: dict) -> bool:
    return data.get("object") == "chat.completion" and isinstance(
        data.get("choices"), list
    )


def _is_openai_chat_sse(text: str) -> bool:
    return "chat.completion.chunk" in text and "data:" in text


def _has_content_type(content_type: str | None, expected: str) -> bool:
    return content_type is not None and content_type.split(";", 1)[0].strip() == expected


def _content_to_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type")
                if btype in ("text", "input_text") and isinstance(
                    block.get("text"), str
                ):
                    parts.append(block["text"])
                else:
                    parts.append(json.dumps(block, indent=2, ensure_ascii=False))
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return json.dumps(content, indent=2, ensure_ascii=False)


def _format_arguments(arguments) -> str:
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except ValueError:
            return arguments
        return json.dumps(parsed, indent=2, ensure_ascii=False)
    return json.dumps(arguments or {}, indent=2, ensure_ascii=False)


def _format_openai_tool_calls(tool_calls: Iterable) -> list[str]:
    lines: list[str] = []
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name", "unknown")
        arguments = _format_arguments(function.get("arguments", ""))
        tool_call_id = tool_call.get("id")
        label = f"[Tool Call: {name}]"
        if isinstance(tool_call_id, str):
            label += f"  ID: {tool_call_id}"
        lines.append(f"{label}\n{arguments}")
    return lines


def _format_anthropic_request(data: dict) -> str:
    lines: list[str] = []
    lines.append(f"[Anthropic API Request]  Model: {data.get('model', 'unknown')}")

    if max_tokens := data.get("max_tokens"):
        lines[-1] += f"  Max Tokens: {max_tokens}"
    if temperature := data.get("temperature"):
        lines[-1] += f"  Temperature: {temperature}"

    lines.append("")

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

    for msg in data.get("messages", []):
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

    if tools := data.get("tools"):
        lines.append("--- Tools ---")
        for tool in tools:
            lines.append(f"  - {tool.get('name', 'unknown')}: {tool.get('description', '')}")
        lines.append("")

    return "\n".join(lines)


def _format_openai_chat_request(data: dict) -> str:
    lines: list[str] = []
    lines.append(
        f"[OpenAI Chat Completions Request]  Model: {data.get('model', 'unknown')}"
    )

    for key, label in (
        ("max_tokens", "Max Tokens"),
        ("temperature", "Temperature"),
        ("stream", "Stream"),
    ):
        if key in data:
            lines[-1] += f"  {label}: {data[key]}"

    lines.append("")

    for msg in data.get("messages", []):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "unknown").upper()
        lines.append(f"--- [{role}] ---")
        if reasoning := msg.get("reasoning_content"):
            lines.append(f"[Reasoning]\n{reasoning}")
        content = _content_to_text(msg.get("content"))
        if msg.get("role") == "tool":
            tool_call_id = msg.get("tool_call_id", "")
            lines.append(f"[Tool Result: {tool_call_id}]\n{content}")
        else:
            if content:
                lines.append(content)
            if tool_calls := msg.get("tool_calls"):
                lines.extend(_format_openai_tool_calls(tool_calls))
        lines.append("")

    if tools := data.get("tools"):
        lines.append("--- Tools ---")
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            function = tool.get("function")
            if isinstance(function, dict):
                name = function.get("name", "unknown")
                description = function.get("description", "")
            else:
                name = tool.get("name", "unknown")
                description = tool.get("description", "")
            lines.append(f"  - {name}: {description}")
        lines.append("")

    return "\n".join(lines)


def _format_anthropic_response_json(data: dict) -> str:
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


def _format_openai_chat_response_json(data: dict) -> str:
    lines: list[str] = []
    model = data.get("model", "unknown")
    lines.append(f"[OpenAI Chat Completions Response]  Model: {model}")

    if usage := data.get("usage"):
        prompt = usage.get("prompt_tokens", 0)
        completion = usage.get("completion_tokens", 0)
        lines[-1] += f"  Tokens: {prompt} in / {completion} out"

    lines.append("")

    for choice in data.get("choices", []):
        if not isinstance(choice, dict):
            continue
        index = choice.get("index", 0)
        message = choice.get("message", {})
        if not isinstance(message, dict):
            continue
        role = message.get("role", "assistant").upper()
        lines.append(f"--- Choice {index} [{role}] ---")
        if reasoning := message.get("reasoning_content"):
            lines.append(f"[Reasoning]\n{reasoning}")
        content = _content_to_text(message.get("content"))
        if content:
            lines.append(content)
        if tool_calls := message.get("tool_calls"):
            lines.extend(_format_openai_tool_calls(tool_calls))
        if finish_reason := choice.get("finish_reason"):
            lines.append(f"[Finish Reason: {finish_reason}]")
        lines.append("")

    return "\n".join(lines)


def _format_anthropic_sse(text: str) -> str:
    lines: list[str] = []
    current_event = ""
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
                    lines.append(f"[Usage]  Output Tokens: {usage.get('output_tokens', 0)}")
                if data.get("delta", {}).get("stop_reason"):
                    lines.append(f"[Stop Reason: {data['delta']['stop_reason']}]")

    if not lines:
        raise ValueError("Not a valid Anthropic SSE stream.")

    return "\n".join(lines)


def _format_openai_chat_sse(text: str) -> str:
    lines: list[str] = []
    model = "unknown"
    role = "assistant"
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: dict[tuple[int, int], dict] = {}
    usage = None
    finish_reasons: list[str] = []

    for line in text.split("\n"):
        if not line.startswith("data: "):
            continue
        data_str = line[6:].strip()
        if not data_str or data_str == "[DONE]":
            continue
        try:
            data = json.loads(data_str)
        except (json.JSONDecodeError, ValueError):
            continue
        if data.get("object") != "chat.completion.chunk":
            continue

        model = data.get("model") or model
        if data.get("usage"):
            usage = data["usage"]
        for choice in data.get("choices", []):
            if not isinstance(choice, dict):
                continue
            if finish_reason := choice.get("finish_reason"):
                finish_reasons.append(str(finish_reason))
            choice_index = choice.get("index", 0)
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            role = delta.get("role") or role
            if isinstance(delta.get("reasoning_content"), str):
                reasoning_parts.append(delta["reasoning_content"])
            if isinstance(delta.get("content"), str):
                content_parts.append(delta["content"])
            for tool_call in delta.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                index = tool_call.get("index", 0)
                if not isinstance(index, int):
                    index = 0
                key = (int(choice_index), index)
                current = tool_calls.setdefault(
                    key, {"id": None, "type": "function", "name": "", "arguments": []}
                )
                if isinstance(tool_call.get("id"), str):
                    current["id"] = tool_call["id"]
                function = tool_call.get("function")
                if isinstance(function, dict):
                    if isinstance(function.get("name"), str):
                        current["name"] += function["name"]
                    if isinstance(function.get("arguments"), str):
                        current["arguments"].append(function["arguments"])

    if model == "unknown" and not content_parts and not reasoning_parts and not tool_calls:
        raise ValueError("Not a valid OpenAI Chat Completions SSE stream.")

    lines.append(f"[OpenAI Chat Completions Stream]  Model: {model}  Role: {role}")
    if usage:
        prompt = usage.get("prompt_tokens", 0)
        completion = usage.get("completion_tokens", 0)
        lines[-1] += f"  Tokens: {prompt} in / {completion} out"
    lines.append("")

    if reasoning_parts:
        lines.append(f"[Reasoning]\n{''.join(reasoning_parts)}\n")
    if content_parts:
        lines.append(f"{''.join(content_parts)}\n")
    for call in tool_calls.values():
        name = call["name"] or "unknown"
        arguments = _format_arguments("".join(call["arguments"]))
        label = f"[Tool Call: {name}]"
        if call["id"]:
            label += f"  ID: {call['id']}"
        lines.append(f"{label}\n{arguments}\n")
    for reason in finish_reasons:
        lines.append(f"[Finish Reason: {reason}]")

    return "\n".join(lines)


class AnthropicApiContentview(Contentview):
    name = "Anthropic API"
    syntax_highlight = "yaml"

    def prettify(self, data: bytes, metadata: Metadata) -> str:
        text = data.decode("utf-8", errors="replace")

        if _is_anthropic_sse(text):
            return _format_anthropic_sse(text)
        if _is_openai_chat_sse(text):
            return _format_openai_chat_sse(text)

        parsed = json.loads(data)
        if _is_anthropic_request(parsed):
            return _format_anthropic_request(parsed)
        if _is_anthropic_response(parsed):
            return _format_anthropic_response_json(parsed)
        if _is_openai_chat_request(parsed):
            return _format_openai_chat_request(parsed)
        if _is_openai_chat_response(parsed):
            return _format_openai_chat_response_json(parsed)

        raise ValueError("Not an Anthropic or OpenAI chat completions API message.")

    def render_priority(self, data: bytes, metadata: Metadata) -> float:
        if not data:
            return 0

        text = data.decode("utf-8", errors="replace")

        if _has_content_type(metadata.content_type, "text/event-stream") and (
            _is_anthropic_sse(text) or _is_openai_chat_sse(text)
        ):
            return 2

        if _has_content_type(metadata.content_type, "application/json"):
            try:
                parsed = json.loads(data)
                if (
                    _is_anthropic_request(parsed)
                    or _is_anthropic_response(parsed)
                    or _is_openai_chat_request(parsed)
                    or _is_openai_chat_response(parsed)
                ):
                    return 2
            except (json.JSONDecodeError, ValueError):
                pass

        return 0


anthropic_api = AnthropicApiContentview()
