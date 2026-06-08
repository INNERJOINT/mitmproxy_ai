import json

from mitmproxy.test import tflow
from mitmproxy.tools.web import subagent
from mitmproxy.tools.web.app import flow_to_json


def _flow_with_request_body(body: bytes, *, session_id: str | None = None):
    f = tflow.tflow(resp=True)
    if session_id is not None:
        f.request.headers["x-claude-code-session-id"] = session_id
    f.request.set_content(body)
    return f


def _launcher_response(
    *, tool_use_id: str, subagent_type: str, index: int = 0
) -> bytes:
    """Build a minimal SSE response for a launcher with one Agent tool_use.

    Mirrors the Anthropic streaming shape: a ``content_block_start`` event
    that names the tool, followed by ``content_block_delta`` events whose
    ``delta.partial_json`` chunks concatenate to the input JSON.
    """
    cbs = {
        "type": "content_block_start",
        "index": index,
        "content_block": {
            "type": "tool_use",
            "id": tool_use_id,
            "name": "Agent",
            "input": {},
        },
    }
    payload = json.dumps({"subagent_type": subagent_type, "description": "x"})
    cbd = {
        "type": "content_block_delta",
        "index": index,
        "delta": {"type": "input_json_delta", "partial_json": payload},
    }
    return (
        b"data: " + json.dumps(cbs).encode() + b"\n\n"
        b"data: " + json.dumps(cbd).encode() + b"\n\n"
    )


def _openai_launcher_response_json(*, tool_use_id: str, subagent_type: str) -> bytes:
    return json.dumps({
        "id": "chatcmpl_1",
        "object": "chat.completion",
        "model": "gpt-4.1",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": tool_use_id,
                            "type": "function",
                            "function": {
                                "name": "Agent",
                                "arguments": json.dumps({
                                    "subagent_type": subagent_type,
                                    "description": "x",
                                }),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
    }).encode()


def _openai_launcher_response_sse(*, tool_use_id: str, subagent_type: str) -> bytes:
    start = {
        "id": "chatcmpl_1",
        "object": "chat.completion.chunk",
        "model": "gpt-4.1",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": tool_use_id,
                            "type": "function",
                            "function": {"name": "Agent", "arguments": ""},
                        }
                    ]
                },
                "finish_reason": None,
            }
        ],
    }
    argument = json.dumps({"subagent_type": subagent_type, "description": "x"})
    pieces = [argument[:10], argument[10:]]
    chunks = [start]
    for piece in pieces:
        chunks.append({
            "id": "chatcmpl_1",
            "object": "chat.completion.chunk",
            "model": "gpt-4.1",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"arguments": piece}}
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        })
    return b"".join(b"data: " + json.dumps(chunk).encode() + b"\n\n" for chunk in chunks)


def test_extract_subagent_marker():
    f = _flow_with_request_body(
        b"prefix... SubagentStart hook additional context: "
        b"Agent oh-my-claudecode:explore started (ab9608b3af968da56) ...suffix",
        session_id="36c573e0-acfb-47e2-98ca-d9dedd1b608f",
    )
    info = subagent.extract(f)
    assert info["is_subagent"] is True
    assert info["subagent_instance_id"] == "ab9608b3af968da56"
    assert info["subagent_type"] == "oh-my-claudecode:explore"
    assert info["claude_session_id"] == "36c573e0-acfb-47e2-98ca-d9dedd1b608f"


def test_extract_no_marker():
    f = _flow_with_request_body(b"just a regular request body")
    info = subagent.extract(f)
    assert info == {"is_subagent": False}


def test_extract_malformed_marker():
    f = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent some-agent started without id"
    )
    info = subagent.extract(f)
    assert info["is_subagent"] is False
    assert "subagent_instance_id" not in info


def test_extract_session_id_without_marker():
    f = _flow_with_request_body(b"plain", session_id="sess-1")
    info = subagent.extract(f)
    assert info["is_subagent"] is False
    assert info["claude_session_id"] == "sess-1"


def test_flow_to_json_surfaces_subagent_fields():
    f = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent x started (deadbeef)",
        session_id="sess-7",
    )
    j = flow_to_json(f)
    assert j["is_subagent"] is True
    assert j["subagent_instance_id"] == "deadbeef"
    assert j["claude_session_id"] == "sess-7"
    assert "parent_flow_id" not in j


def test_flow_to_json_omits_subagent_fields_for_normal_flow():
    f = tflow.tflow(resp=True)
    j = flow_to_json(f)
    assert "is_subagent" not in j
    assert "subagent_instance_id" not in j
    assert "parent_flow_id" not in j
    assert "is_launcher" not in j


def test_resolve_parent_links_pairs_parent_to_subagent():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.request.set_content(b"parent prompt")
    parent.response.set_content(
        _launcher_response(tool_use_id="toolu_1", subagent_type="X")
    )

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent X started (cafe1234)",
        session_id="sess-A",
    )

    subagent.resolve_parent_links([parent, child])
    assert child.metadata.get("subagent_parent_id") == parent.id
    assert child.metadata.get("subagent_is_orphan") is False

    j = flow_to_json(child)
    assert j["parent_flow_id"] == parent.id
    assert j.get("is_orphan") is not True


def test_resolve_parent_links_skips_other_session_marks_orphan():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(
        _launcher_response(tool_use_id="toolu_1", subagent_type="X")
    )

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent X started (abcd)",
        session_id="sess-B",
    )

    subagent.resolve_parent_links([parent, child])
    assert "subagent_parent_id" not in child.metadata
    assert child.metadata.get("subagent_is_orphan") is True
    j = flow_to_json(child)
    assert j.get("is_orphan") is True


def test_parse_launches_openai_json_response():
    parent = tflow.tflow(resp=True)
    parent.response.set_content(
        _openai_launcher_response_json(tool_use_id="call_1", subagent_type="Explore")
    )

    assert subagent.parse_launches(parent) == [
        {"tool_use_id": "call_1", "subagent_type": "Explore", "description": "x"}
    ]


def test_parse_launches_openai_sse_response():
    parent = tflow.tflow(resp=True)
    parent.response.set_content(
        _openai_launcher_response_sse(tool_use_id="call_1", subagent_type="Explore")
    )

    assert subagent.parse_launches(parent) == [
        {"tool_use_id": "call_1", "subagent_type": "Explore", "description": "x"}
    ]


def test_resolve_parent_links_pairs_openai_launcher_to_subagent():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(
        _openai_launcher_response_sse(tool_use_id="call_1", subagent_type="Explore")
    )

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent Explore started (deadbeef)",
        session_id="sess-A",
    )

    subagent.resolve_parent_links([parent, child])
    assert child.metadata.get("subagent_parent_id") == parent.id
    assert child.metadata.get("subagent_is_orphan") is False
    assert parent.metadata["subagent_launches"] == [
        {"tool_use_id": "call_1", "subagent_type": "Explore", "description": "x"}
    ]


def test_resolve_parent_links_groups_run_by_instance_hex():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(
        _launcher_response(tool_use_id="toolu_1", subagent_type="Explore")
    )
    children = [
        _flow_with_request_body(
            b"SubagentStart hook additional context: Agent Explore started (a816766dc54a7a03f)"
            + b" (turn " + str(i).encode() + b")",
            session_id="sess-A",
        )
        for i in range(3)
    ]
    subagent.resolve_parent_links([parent, *children])
    for c in children:
        assert c.metadata["subagent_parent_id"] == parent.id
        assert c.metadata["subagent_is_orphan"] is False
        assert c.metadata["subagent_type"] == "Explore"
    assert parent.metadata["subagent_child_runs"] == [
        {
            "instance_id": "a816766dc54a7a03f",
            "subagent_type": "Explore",
            "flow_ids": [c.id for c in children],
        }
    ]


def test_resolve_parent_links_type_mismatch_does_not_steal():
    """A later launcher with the wrong subagent_type must not steal children."""
    plan_launcher = tflow.tflow(resp=True)
    plan_launcher.request.headers["x-claude-code-session-id"] = "sess-A"
    plan_launcher.request.timestamp_start = 1000.0
    plan_launcher.response.set_content(
        _launcher_response(tool_use_id="toolu_plan", subagent_type="Plan")
    )

    explore_launcher = tflow.tflow(resp=True)
    explore_launcher.request.headers["x-claude-code-session-id"] = "sess-A"
    explore_launcher.request.timestamp_start = 1001.0
    explore_launcher.response.set_content(
        _launcher_response(tool_use_id="toolu_explore", subagent_type="Explore")
    )

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent Explore started (deadbeef)",
        session_id="sess-A",
    )
    child.request.timestamp_start = 1002.0

    subagent.resolve_parent_links([plan_launcher, explore_launcher, child])
    # Must link to explore_launcher (matching type), not plan_launcher.
    assert child.metadata["subagent_parent_id"] == explore_launcher.id
    assert "subagent_child_runs" not in plan_launcher.metadata
    assert explore_launcher.metadata["subagent_child_runs"][0]["instance_id"] == "deadbeef"


def test_namespaced_agent_type_matches_bare_subagent_type():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(
        _launcher_response(tool_use_id="toolu_1", subagent_type="Explore")
    )
    child = _flow_with_request_body(
        b"SubagentStart hook additional context: "
        b"Agent oh-my-claudecode:explore started (deadbeef)",
        session_id="sess-A",
    )
    subagent.resolve_parent_links([parent, child])
    assert child.metadata["subagent_parent_id"] == parent.id


def test_launcher_metadata_surfaced_in_json():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(
        _launcher_response(tool_use_id="toolu_1", subagent_type="Explore")
    )
    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent Explore started (deadbeef)",
        session_id="sess-A",
    )
    subagent.resolve_parent_links([parent, child])
    j = flow_to_json(parent)
    assert j["is_launcher"] is True
    assert j["child_subagent_runs"][0]["instance_id"] == "deadbeef"
    assert j["subagent_launches"][0]["subagent_type"] == "Explore"
