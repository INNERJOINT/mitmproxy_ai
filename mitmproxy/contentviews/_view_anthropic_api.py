import json
from collections.abc import Iterable

from mitmproxy.contentviews._api import Contentview
from mitmproxy.contentviews._api import Metadata

MAX_SSE_EVENTS = 5000
MAX_SSE_DATA_CHARS = 1_000_000
MAX_ACCUMULATED_CHARS = 1_000_000


def _append_limited(parts: list[str], value: str, state: dict[str, int]) -> None:
    remaining = MAX_ACCUMULATED_CHARS - state.get("chars", 0)
    if remaining <= 0:
        return
    parts.append(value[:remaining])
    state["chars"] = state.get("chars", 0) + min(len(value), remaining)


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


def _iter_sse_lines(text: str):
    start = 0
    while start <= len(text):
        end = text.find("\n", start)
        if end == -1:
            yield text[start:]
            break
        yield text[start:end]
        start = end + 1


def _iter_sse_data(text: str):
    count = 0
    for line in _iter_sse_lines(text):
        if count >= MAX_SSE_EVENTS:
            break
        if not line.startswith("data: "):
            continue
        data_str = line[6:].strip()
        if not data_str or data_str == "[DONE]":
            continue
        if len(data_str) > MAX_SSE_DATA_CHARS:
            continue
        try:
            data = json.loads(data_str)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict):
            count += 1
            yield data


def _iter_sse_events(text: str):
    count = 0
    current_event = ""
    for line in _iter_sse_lines(text):
        if count >= MAX_SSE_EVENTS:
            break
        if line.startswith("event: "):
            current_event = line[7:].strip()
            continue
        if not line.startswith("data: "):
            continue
        data_str = line[6:].strip()
        if not data_str or data_str == "[DONE]":
            continue
        if len(data_str) > MAX_SSE_DATA_CHARS:
            continue
        try:
            data = json.loads(data_str)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(data, dict):
            count += 1
            yield current_event, data


def _is_openai_responses_request(data: dict) -> bool:
    return (
        isinstance(data.get("model"), str)
        and "input" in data
        and data.get("object") != "response"
    )


def _is_openai_responses_response(data: dict) -> bool:
    return data.get("object") == "response" and isinstance(data.get("output"), list)


def _is_openai_responses_sse(text: str) -> bool:
    if "data:" not in text or "response." not in text:
        return False
    return any(
        isinstance(data.get("type"), str) and data["type"].startswith("response.")
        for data in _iter_sse_data(text)
    )


def _is_llm_sse(text: str) -> bool:
    return (
        _is_anthropic_sse(text)
        or _is_openai_chat_sse(text)
        or _is_openai_responses_sse(text)
    )


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
                if btype in (
                    "text",
                    "input_text",
                    "output_text",
                    "summary_text",
                ) and isinstance(block.get("text"), str):
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


def _format_openai_responses_tools(tools) -> list[str]:
    lines: list[str] = []
    if not tools:
        return lines

    lines.append("--- Tools ---")
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if not isinstance(name, str):
            function = tool.get("function")
            if isinstance(function, dict):
                name = function.get("name")
        description = tool.get("description", "")
        if not isinstance(name, str):
            name = tool.get("type", "unknown")
        lines.append(f"  - {name}: {description}")
    lines.append("")
    return lines


def _format_openai_responses_input_item(item: dict, index: int) -> list[str]:
    lines: list[str] = []
    item_type = item.get("type", "unknown")

    if item_type == "message":
        role = str(item.get("role", "unknown")).upper()
        lines.append(f"--- Input {index} [{role}] ---")
        content = _content_to_text(item.get("content"))
        if content:
            lines.append(content)
    elif item_type == "function_call":
        name = item.get("name", "unknown")
        label = f"[Tool Call: {name}]"
        if call_id := item.get("call_id"):
            label += f"  ID: {call_id}"
        lines.append(label)
        lines.append(_format_arguments(item.get("arguments", "")))
    elif item_type == "function_call_output":
        call_id = item.get("call_id", "unknown")
        lines.append(f"[Tool Result: {call_id}]")
        output = item.get("output", item.get("content", ""))
        lines.append(_content_to_text(output))
    elif item_type == "reasoning":
        lines.append(f"--- Input {index} [REASONING] ---")
        summary = _content_to_text(item.get("summary"))
        if summary:
            lines.append(f"[Reasoning Summary]\n{summary}")
    else:
        lines.append(f"--- Input {index} [{item_type}] ---")
        lines.append(json.dumps(item, indent=2, ensure_ascii=False))

    lines.append("")
    return lines


def _format_openai_responses_output_item(item: dict, index: int | None = None) -> list[str]:
    lines: list[str] = []
    item_type = item.get("type", "unknown")
    prefix = f"Output {index}" if index is not None else "Output"

    if item_type == "message":
        role = str(item.get("role", "assistant")).upper()
        lines.append(f"--- {prefix} [{role}] ---")
        content = _content_to_text(item.get("content"))
        if content:
            lines.append(content)
    elif item_type == "reasoning":
        summary = _content_to_text(item.get("summary"))
        if summary:
            lines.append(f"[Reasoning Summary]\n{summary}")
    elif item_type == "function_call":
        name = item.get("name", "unknown")
        label = f"[Tool Call: {name}]"
        if call_id := item.get("call_id"):
            label += f"  ID: {call_id}"
        lines.append(label)
        lines.append(_format_arguments(item.get("arguments", "")))
    elif item_type == "function_call_output":
        call_id = item.get("call_id", "unknown")
        lines.append(f"[Tool Result: {call_id}]")
        output = item.get("output", item.get("content", ""))
        lines.append(_content_to_text(output))
    else:
        lines.append(f"--- {prefix} [{item_type}] ---")
        lines.append(json.dumps(item, indent=2, ensure_ascii=False))

    if lines:
        lines.append("")
    return lines


def _format_openai_responses_request(data: dict) -> str:
    lines: list[str] = []
    lines.append(f"[OpenAI Responses Request]  Model: {data.get('model', 'unknown')}")

    for key, label in (
        ("stream", "Stream"),
        ("parallel_tool_calls", "Parallel Tools"),
        ("store", "Store"),
        ("max_output_tokens", "Max Output Tokens"),
    ):
        if key in data:
            lines[-1] += f"  {label}: {data[key]}"
    if isinstance(data.get("reasoning"), dict):
        reasoning = data["reasoning"]
        details = ", ".join(
            f"{key}: {value}" for key, value in reasoning.items() if value is not None
        )
        if details:
            lines[-1] += f"  Reasoning: {details}"

    lines.append("")
    if instructions := data.get("instructions"):
        lines.append("--- Instructions ---")
        lines.append(_content_to_text(instructions))
        lines.append("")

    input_data = data.get("input")
    if isinstance(input_data, list):
        for index, item in enumerate(input_data):
            if isinstance(item, dict):
                lines.extend(_format_openai_responses_input_item(item, index))
            else:
                lines.append(f"--- Input {index} ---")
                lines.append(_content_to_text(item))
                lines.append("")
    elif input_data is not None:
        lines.append("--- Input ---")
        lines.append(_content_to_text(input_data))
        lines.append("")

    lines.extend(_format_openai_responses_tools(data.get("tools")))
    return "\n".join(lines)


def _format_openai_responses_response_json(data: dict) -> str:
    lines: list[str] = []
    model = data.get("model", "unknown")
    status = data.get("status", "unknown")
    lines.append(f"[OpenAI Responses Response]  Model: {model}  Status: {status}")

    if usage := data.get("usage"):
        inp = usage.get("input_tokens", 0)
        out = usage.get("output_tokens", 0)
        lines[-1] += f"  Tokens: {inp} in / {out} out"
    if error := data.get("error"):
        lines[-1] += f"  Error: {error}"

    lines.append("")
    for index, item in enumerate(data.get("output", [])):
        if isinstance(item, dict):
            lines.extend(_format_openai_responses_output_item(item, index))

    return "\n".join(lines)


def _format_openai_responses_sse(text: str) -> str:
    lines: list[str] = []
    model = "unknown"
    status = "unknown"
    content_parts: list[str] = []
    content_done_parts: list[str] = []
    reasoning_parts: list[str] = []
    reasoning_done_parts: list[str] = []
    text_state = {"chars": 0}
    tool_state = {"chars": 0}
    tool_calls: dict[str, dict] = {}
    usage = None

    for data in _iter_sse_data(text):
        event_type = data.get("type")
        response = data.get("response")
        if isinstance(response, dict):
            model = response.get("model") or model
            status = response.get("status") or status
            if response.get("usage"):
                usage = response["usage"]

        if event_type == "response.output_text.delta" and isinstance(
            data.get("delta"), str
        ):
            _append_limited(content_parts, data["delta"], text_state)
        elif event_type == "response.content_part.done":
            part = data.get("part")
            if isinstance(part, dict) and part.get("type") == "output_text":
                text_part = part.get("text")
                if isinstance(text_part, str):
                    _append_limited(content_done_parts, text_part, text_state)
        elif event_type == "response.reasoning_summary_text.delta" and isinstance(
            data.get("delta"), str
        ):
            _append_limited(reasoning_parts, data["delta"], text_state)
        elif event_type == "response.output_item.done":
            item = data.get("item")
            if not isinstance(item, dict):
                continue
            if item.get("type") == "reasoning":
                summary = _content_to_text(item.get("summary"))
                if summary:
                    _append_limited(reasoning_done_parts, summary, text_state)
            elif item.get("type") == "function_call":
                item_id = item.get("id")
                if not isinstance(item_id, str):
                    item_id = item.get("call_id", str(data.get("output_index", 0)))
                call = tool_calls.setdefault(
                    item_id,
                    {"id": item.get("call_id"), "name": "", "arguments": []},
                )
                call["id"] = item.get("call_id") or call.get("id")
                call["name"] = item.get("name") or call.get("name")
                if isinstance(item.get("arguments"), str):
                    arguments: list[str] = []
                    _append_limited(arguments, item["arguments"], tool_state)
                    call["arguments"] = arguments
        elif event_type == "response.output_item.added":
            item = data.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                item_id = item.get("id")
                if not isinstance(item_id, str):
                    item_id = item.get("call_id", str(data.get("output_index", 0)))
                call = tool_calls.setdefault(
                    item_id,
                    {"id": item.get("call_id"), "name": "", "arguments": []},
                )
                call["id"] = item.get("call_id") or call.get("id")
                call["name"] = item.get("name") or call.get("name")
        elif event_type in (
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ):
            item_id = data.get("item_id", str(data.get("output_index", 0)))
            call = tool_calls.setdefault(
                item_id, {"id": None, "name": "unknown", "arguments": []}
            )
            if event_type.endswith(".done") and isinstance(data.get("arguments"), str):
                arguments: list[str] = []
                _append_limited(arguments, data["arguments"], tool_state)
                call["arguments"] = arguments
            elif isinstance(data.get("delta"), str):
                _append_limited(call["arguments"], data["delta"], tool_state)

    if (
        model == "unknown"
        and not content_parts
        and not content_done_parts
        and not reasoning_parts
        and not reasoning_done_parts
        and not tool_calls
    ):
        raise ValueError("Not a valid OpenAI Responses SSE stream.")

    lines.append(f"[OpenAI Responses Stream]  Model: {model}  Status: {status}")
    if usage:
        inp = usage.get("input_tokens", 0)
        out = usage.get("output_tokens", 0)
        lines[-1] += f"  Tokens: {inp} in / {out} out"
    lines.append("")

    reasoning = "".join(reasoning_parts) or "\n".join(reasoning_done_parts)
    if reasoning:
        lines.append(f"[Reasoning Summary]\n{reasoning}\n")
    content = "".join(content_parts) or "\n".join(content_done_parts)
    if content:
        lines.append(f"{content}\n")
    for call in tool_calls.values():
        label = f"[Tool Call: {call.get('name') or 'unknown'}]"
        if call.get("id"):
            label += f"  ID: {call['id']}"
        lines.append(f"{label}\n{_format_arguments(''.join(call['arguments']))}\n")

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
    content_blocks: dict[int, dict] = {}
    text_state = {"chars": 0}

    for current_event, data in _iter_sse_events(text):
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
            content: list[str] = []
            initial = block.get("thinking", "") or block.get("text", "")
            if isinstance(initial, str) and initial:
                _append_limited(content, initial, text_state)
            content_blocks[index] = {
                "type": block.get("type", ""),
                "content": content,
                "name": block.get("name", ""),
            }

        elif current_event == "content_block_delta":
            delta = data.get("delta", {})
            index = data.get("index", 0)
            block = content_blocks.get(index)
            if block:
                dtype = delta.get("type", "")
                if dtype == "thinking_delta" and isinstance(delta.get("thinking"), str):
                    _append_limited(block["content"], delta["thinking"], text_state)
                elif dtype == "text_delta" and isinstance(delta.get("text"), str):
                    _append_limited(block["content"], delta["text"], text_state)
                elif dtype == "input_json_delta" and isinstance(
                    delta.get("partial_json"), str
                ):
                    _append_limited(block["content"], delta["partial_json"], text_state)

        elif current_event == "content_block_stop":
            index = data.get("index", 0)
            block = content_blocks.pop(index, None)
            if block:
                content = "".join(block["content"])
                btype = block["type"]
                if btype == "thinking":
                    lines.append(f"[Thinking]\n{content}\n")
                elif btype == "text":
                    lines.append(f"{content}\n")
                elif btype == "tool_use":
                    name = block.get("name", "unknown")
                    lines.append(f"[Tool Call: {name}]\n{content}\n")

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
    text_state = {"chars": 0}
    tool_calls: dict[tuple[int, int], dict] = {}
    tool_state = {"chars": 0}
    usage = None
    finish_reasons: list[str] = []

    for data in _iter_sse_data(text):
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
                _append_limited(reasoning_parts, delta["reasoning_content"], text_state)
            if isinstance(delta.get("content"), str):
                _append_limited(content_parts, delta["content"], text_state)
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
                        _append_limited(
                            current["arguments"], function["arguments"], tool_state
                        )

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
        if _is_openai_responses_sse(text):
            return _format_openai_responses_sse(text)

        parsed = json.loads(data)
        if _is_anthropic_request(parsed):
            return _format_anthropic_request(parsed)
        if _is_anthropic_response(parsed):
            return _format_anthropic_response_json(parsed)
        if _is_openai_chat_request(parsed):
            return _format_openai_chat_request(parsed)
        if _is_openai_chat_response(parsed):
            return _format_openai_chat_response_json(parsed)
        if _is_openai_responses_request(parsed):
            return _format_openai_responses_request(parsed)
        if _is_openai_responses_response(parsed):
            return _format_openai_responses_response_json(parsed)

        raise ValueError("Not an Anthropic or OpenAI API message.")

    def render_priority(self, data: bytes, metadata: Metadata) -> float:
        if not data:
            return 0

        text = data.decode("utf-8", errors="replace")

        if _has_content_type(metadata.content_type, "text/event-stream") and _is_llm_sse(
            text
        ):
            return 2

        if _is_llm_sse(text):
            return 1.5

        if _has_content_type(metadata.content_type, "application/json"):
            try:
                parsed = json.loads(data)
                if (
                    _is_anthropic_request(parsed)
                    or _is_anthropic_response(parsed)
                    or _is_openai_chat_request(parsed)
                    or _is_openai_chat_response(parsed)
                    or _is_openai_responses_request(parsed)
                    or _is_openai_responses_response(parsed)
                ):
                    return 2
            except (json.JSONDecodeError, ValueError):
                pass

        return 0


anthropic_api = AnthropicApiContentview()
