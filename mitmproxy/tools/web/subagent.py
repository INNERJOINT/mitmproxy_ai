"""Detection of Claude Code subagent flows.

Heuristic is body-based: Claude Code injects a marker of the form
`SubagentStart hook additional context: Agent <type> started (<hex-id>)`
into the request body of every subagent invocation. The session id
header (`x-claude-code-session-id`) is shared between parent and
subagent flows and therefore cannot be used to discriminate.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mitmproxy.http import HTTPFlow


SUBAGENT_FAST_PATH = b"SubagentStart"

SUBAGENT_MARKER_RE = re.compile(
    rb"SubagentStart hook additional context:\s*Agent\s+\S+\s+started\s*\(([0-9a-fA-F]+)\)"
)

AGENT_TOOL_CALL_MARKER = b'"name":"Agent"'


def extract(flow: "HTTPFlow") -> dict:
    """Return subagent classification for an HTTPFlow.

    Always returns a dict with at least ``is_subagent``. When the flow is a
    subagent invocation, ``subagent_instance_id`` is set. ``claude_session_id``
    is set whenever the request carries the Claude Code session header.
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
    result["subagent_instance_id"] = match.group(1).decode("ascii")
    return result


def response_launches_agent(flow: "HTTPFlow") -> bool:
    """True if the response body of ``flow`` contains an Agent tool call.

    Used by the parent-linkage heuristic. Treats the marker as a literal
    byte sequence inside SSE/JSON; works because Claude Code emits the tool
    call name verbatim in its streaming chunks.
    """
    response = getattr(flow, "response", None)
    if response is None:
        return False
    raw = response.raw_content
    if not raw:
        return False
    return AGENT_TOOL_CALL_MARKER in raw


def resolve_parent_links(flows) -> None:
    """Populate ``flow.metadata['subagent_parent_id']`` for subagent flows.

    Walks ``flows`` in their given order. For each subagent flow, the parent
    is the most recent prior non-subagent HTTPFlow that (a) shares the same
    Claude session id and (b) has a response containing an Agent tool call.
    Skips flows that already have a cached parent id in metadata.
    """
    last_launcher_by_session: dict[str, str] = {}

    for flow in flows:
        request = getattr(flow, "request", None)
        if request is None:
            continue
        info = extract(flow)
        session_id = info.get("claude_session_id")
        if not info.get("is_subagent"):
            if session_id and response_launches_agent(flow):
                last_launcher_by_session[session_id] = flow.id
            continue

        if flow.metadata.get("subagent_parent_id"):
            continue
        if not session_id:
            continue
        parent_id = last_launcher_by_session.get(session_id)
        if parent_id and parent_id != flow.id:
            flow.metadata["subagent_parent_id"] = parent_id
