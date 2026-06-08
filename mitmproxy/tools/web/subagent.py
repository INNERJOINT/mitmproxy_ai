"""Detection of Claude Code subagent flows and their launchers.

Claude Code injects a marker of the form
``SubagentStart hook additional context: Agent <type> started (<hex-id>)``
into the request body of every subagent invocation. The hex id is stable
across all turns of one subagent run, so it is the natural grouping key.

Launcher flows can be identified by their response: any Anthropic
``tool_use`` block whose ``name`` is ``Agent`` (or ``Task``, the legacy
name) launches a subagent and carries an ``input.subagent_type`` field
that names the agent type to spawn.

Linkage strategy: each subagent run (set of flows sharing one instance
hex) is paired with the most recent prior launcher in the same Claude
Code session whose ``subagent_type`` matches the marker's agent type
(case-insensitive, with namespace-suffix matching so that
``oh-my-claudecode:explore`` matches ``Explore``). Subagent runs whose
launcher cannot be found in the captured flows are flagged as orphans;
the frontend offers manual cross-session association.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from dataclasses import field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mitmproxy.http import HTTPFlow


SUBAGENT_FAST_PATH = b"SubagentStart"

SUBAGENT_MARKER_RE = re.compile(
    rb"SubagentStart hook additional context:\s*Agent\s+(\S+)\s+started\s*\(([0-9a-fA-F]+)\)"
)

AGENT_TOOL_NAMES = ("Agent", "Task")

# Either form may appear depending on Claude Code version / tool naming.
# Real Anthropic SSE writes ``"name":"Agent"`` (no space); some tooling and
# tests may pretty-print with a space, so accept both.
AGENT_TOOL_CALL_FAST_PATHS = (
    b'"name":"Agent"',
    b'"name": "Agent"',
    b'"name":"Task"',
    b'"name": "Task"',
    b'"tool_calls"',
)

# SSE chunks that contribute to a tool_use input. Anthropic and OpenAI both
# expose streaming payloads as one ``data: <json>`` line per event.
_SSE_DATA_RE = re.compile(rb"^data:\s*(\{.*\})\s*$", re.MULTILINE)


def extract(flow: "HTTPFlow") -> dict:
    """Return subagent classification for an HTTPFlow.

    Always returns a dict with at least ``is_subagent``. When the flow is a
    subagent invocation, ``subagent_instance_id`` and ``subagent_type`` are
    set. ``claude_session_id`` is set whenever the request carries the
    Claude Code session header.
    """
    result: dict = {"is_subagent": False}

    request = getattr(flow, "request", None)
    if request is None:
        return result

    session_id = request.headers.get("x-claude-code-session-id")
    if session_id:
        result["claude_session_id"] = session_id

    raw = request.raw_content
    if not raw or SUBAGENT_FAST_PATH not in raw:
        return result

    match = SUBAGENT_MARKER_RE.search(raw)
    if match is None:
        return result

    result["is_subagent"] = True
    result["subagent_type"] = match.group(1).decode("utf-8", "replace")
    result["subagent_instance_id"] = match.group(2).decode("ascii")
    return result


def response_launches_agent(flow: "HTTPFlow") -> bool:
    """True if the response body of ``flow`` contains an Agent/Task tool call."""
    return bool(parse_launches(flow))


def _launch_record(tool_use_id: str, payload: object) -> dict:
    subagent_type: str | None = None
    description: str | None = None
    if isinstance(payload, dict):
        st = payload.get("subagent_type")
        if isinstance(st, str):
            subagent_type = st
        desc = payload.get("description")
        if isinstance(desc, str):
            description = desc
    return {
        "tool_use_id": tool_use_id,
        "subagent_type": subagent_type,
        "description": description,
    }


def _loads_input_json(text: str) -> object:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _parse_anthropic_launches(raw: bytes) -> list[dict]:
    starts: dict[int, tuple[str, str]] = {}  # idx -> (tool_use_id, name)
    deltas: dict[int, list[str]] = {}

    for m in _SSE_DATA_RE.finditer(raw):
        try:
            event = json.loads(m.group(1).decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        idx = event.get("index")
        if etype == "content_block_start" and isinstance(idx, int):
            block = event.get("content_block")
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if name not in AGENT_TOOL_NAMES:
                continue
            tool_use_id = block.get("id")
            if isinstance(tool_use_id, str):
                starts[idx] = (tool_use_id, name)
                deltas.setdefault(idx, [])
        elif etype == "content_block_delta" and isinstance(idx, int):
            delta = event.get("delta")
            if (
                isinstance(delta, dict)
                and delta.get("type") == "input_json_delta"
                and idx in deltas
            ):
                partial = delta.get("partial_json", "")
                if isinstance(partial, str):
                    deltas[idx].append(partial)
        elif etype == "input_json_delta" and isinstance(idx, int):
            if idx in deltas:
                partial = event.get("partial_json", "")
                if isinstance(partial, str):
                    deltas[idx].append(partial)

    return [
        _launch_record(tool_use_id, _loads_input_json("".join(deltas.get(idx, []))))
        for idx, (tool_use_id, _name) in starts.items()
    ]


def _openai_launch_from_tool_call(
    tool_call: dict, fallback_id: str | None = None
) -> dict | None:
    function = tool_call.get("function")
    if not isinstance(function, dict):
        return None
    name = function.get("name")
    if name not in AGENT_TOOL_NAMES:
        return None
    tool_use_id = tool_call.get("id")
    if not isinstance(tool_use_id, str):
        tool_use_id = fallback_id
    if not isinstance(tool_use_id, str):
        return None
    arguments = function.get("arguments", "")
    payload = _loads_input_json(arguments) if isinstance(arguments, str) else arguments
    return _launch_record(tool_use_id, payload)


def _parse_openai_json_launches(raw: bytes) -> list[dict]:
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return []
    if not isinstance(data, dict) or data.get("object") != "chat.completion":
        return []

    launches: list[dict] = []
    for choice in data.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        choice_index = choice.get("index", 0)
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        for i, tool_call in enumerate(message.get("tool_calls") or []):
            if not isinstance(tool_call, dict):
                continue
            record = _openai_launch_from_tool_call(
                tool_call, f"openai:{choice_index}:{i}"
            )
            if record is not None:
                launches.append(record)
    return launches


def _parse_openai_sse_launches(raw: bytes) -> list[dict]:
    calls: dict[tuple[int, int], dict] = {}

    for m in _SSE_DATA_RE.finditer(raw):
        try:
            event = json.loads(m.group(1).decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(event, dict) or event.get("object") != "chat.completion.chunk":
            continue
        for choice in event.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            choice_index = choice.get("index", 0)
            if not isinstance(choice_index, int):
                choice_index = 0
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            for tool_call in delta.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                tool_index = tool_call.get("index", 0)
                if not isinstance(tool_index, int):
                    tool_index = 0
                key = (choice_index, tool_index)
                call = calls.setdefault(
                    key, {"id": None, "name": [], "arguments": []}
                )
                if isinstance(tool_call.get("id"), str):
                    call["id"] = tool_call["id"]
                function = tool_call.get("function")
                if isinstance(function, dict):
                    if isinstance(function.get("name"), str):
                        call["name"].append(function["name"])
                    if isinstance(function.get("arguments"), str):
                        call["arguments"].append(function["arguments"])

    launches: list[dict] = []
    for (choice_index, tool_index), call in calls.items():
        record = _openai_launch_from_tool_call(
            {
                "id": call["id"],
                "function": {
                    "name": "".join(call["name"]),
                    "arguments": "".join(call["arguments"]),
                },
            },
            f"openai:{choice_index}:{tool_index}",
        )
        if record is not None:
            launches.append(record)
    return launches


def parse_launches(flow: "HTTPFlow") -> list[dict]:
    """Return launch records from Anthropic or OpenAI chat-completion responses.

    Each record is ``{"tool_use_id": str, "subagent_type": str | None,
    "description": str | None}``. Returns ``[]`` if the response is not a
    launcher or cannot be parsed.
    """
    response = getattr(flow, "response", None)
    if response is None:
        return []
    raw = response.raw_content
    if not raw or not any(m in raw for m in AGENT_TOOL_CALL_FAST_PATHS):
        return []

    return (
        _parse_anthropic_launches(raw)
        + _parse_openai_json_launches(raw)
        + _parse_openai_sse_launches(raw)
    )


def _types_match(launcher_type: str | None, marker_type: str) -> bool:
    """Match a launcher's subagent_type against a marker's agent type.

    Case-insensitive. If either is of the form ``namespace:name``, the
    suffix after the last ``:`` is compared against the other side's
    bare/suffix form. So ``oh-my-claudecode:explore`` matches ``Explore``.
    """
    if launcher_type is None:
        return False
    a = launcher_type.rsplit(":", 1)[-1].strip().lower()
    b = marker_type.rsplit(":", 1)[-1].strip().lower()
    return bool(a) and a == b


@dataclass
class _SubagentRun:
    instance_hex: str
    subagent_type: str
    session_id: str | None
    flow_ids: list[str] = field(default_factory=list)
    first_time: float = 0.0
    parent_flow_id: str | None = None


@dataclass
class _Launcher:
    flow_id: str
    session_id: str | None
    time: float
    launches: list[dict]  # records from parse_launches
    children: list[_SubagentRun] = field(default_factory=list)


def _flow_time(flow) -> float:
    request = getattr(flow, "request", None)
    if request is not None:
        ts = getattr(request, "timestamp_start", None)
        if ts is not None:
            return float(ts)
    return 0.0


def resolve_parent_links(flows) -> None:
    """Populate parent linkage and orphan/launcher metadata on ``flows``.

    Pass 1 classifies every flow as launcher / subagent / neither. Pass 2
    pairs each subagent run (grouped by instance hex) with the most
    recent prior launcher in the same session whose ``subagent_type``
    matches the marker's agent type. Pass 3 writes the result onto each
    flow's metadata.

    Metadata written:
      - ``subagent_parent_id`` (str | None) on each subagent flow
      - ``subagent_is_orphan`` (bool) on each subagent flow
      - ``subagent_type`` (str) on each subagent flow
      - ``subagent_child_runs`` (list[dict]) on each launcher flow with
        children: ``[{"instance_id", "subagent_type", "flow_ids"}]``
    """
    flow_by_id: dict[str, object] = {}
    runs: dict[str, _SubagentRun] = {}
    launchers_by_session: dict[str | None, list[_Launcher]] = {}
    all_launchers: list[_Launcher] = []

    # Pass 1: classify
    for flow in flows:
        if getattr(flow, "request", None) is None:
            continue
        flow_by_id[flow.id] = flow
        info = extract(flow)
        session_id = info.get("claude_session_id")
        time = _flow_time(flow)

        if info.get("is_subagent"):
            hex_id = info["subagent_instance_id"]
            run = runs.get(hex_id)
            if run is None:
                run = _SubagentRun(
                    instance_hex=hex_id,
                    subagent_type=info["subagent_type"],
                    session_id=session_id,
                    first_time=time,
                )
                runs[hex_id] = run
            run.flow_ids.append(flow.id)
            if time and (not run.first_time or time < run.first_time):
                run.first_time = time
        else:
            launches = parse_launches(flow)
            if launches:
                launcher = _Launcher(
                    flow_id=flow.id,
                    session_id=session_id,
                    time=time,
                    launches=launches,
                )
                launchers_by_session.setdefault(session_id, []).append(launcher)
                all_launchers.append(launcher)

    # Pass 2: pair runs to launchers
    for run in runs.values():
        candidates = launchers_by_session.get(run.session_id, [])
        for launcher in reversed(candidates):
            if launcher.time > run.first_time and run.first_time:
                continue
            if any(
                _types_match(launch.get("subagent_type"), run.subagent_type)
                for launch in launcher.launches
            ):
                run.parent_flow_id = launcher.flow_id
                launcher.children.append(run)
                break

    # Pass 3: write back
    for run in runs.values():
        is_orphan = run.parent_flow_id is None
        for fid in run.flow_ids:
            f = flow_by_id.get(fid)
            if f is None:
                continue
            if run.parent_flow_id and run.parent_flow_id != fid:
                f.metadata["subagent_parent_id"] = run.parent_flow_id
            else:
                f.metadata.pop("subagent_parent_id", None)
            f.metadata["subagent_is_orphan"] = is_orphan
            f.metadata["subagent_type"] = run.subagent_type

    for launcher in all_launchers:
        f = flow_by_id.get(launcher.flow_id)
        if f is None:
            continue
        if launcher.children:
            f.metadata["subagent_child_runs"] = [
                {
                    "instance_id": child.instance_hex,
                    "subagent_type": child.subagent_type,
                    "flow_ids": list(child.flow_ids),
                }
                for child in launcher.children
            ]
        else:
            f.metadata.pop("subagent_child_runs", None)
        # Record what this launcher tried to spawn even if no child run is
        # in the capture — useful for "Find candidate parents" matching.
        f.metadata["subagent_launches"] = [
            {
                "tool_use_id": rec["tool_use_id"],
                "subagent_type": rec.get("subagent_type"),
                "description": rec.get("description"),
            }
            for rec in launcher.launches
        ]
