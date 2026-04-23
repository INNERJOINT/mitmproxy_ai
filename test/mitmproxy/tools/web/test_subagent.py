from mitmproxy.test import tflow
from mitmproxy.tools.web import subagent
from mitmproxy.tools.web.app import flow_to_json


def _flow_with_request_body(body: bytes, *, session_id: str | None = None):
    f = tflow.tflow(resp=True)
    if session_id is not None:
        f.request.headers["x-claude-code-session-id"] = session_id
    f.request.set_content(body)
    return f


def test_extract_subagent_marker():
    f = _flow_with_request_body(
        b"prefix... SubagentStart hook additional context: "
        b"Agent oh-my-claudecode:explore started (ab9608b3af968da56) ...suffix",
        session_id="36c573e0-acfb-47e2-98ca-d9dedd1b608f",
    )
    info = subagent.extract(f)
    assert info["is_subagent"] is True
    assert info["subagent_instance_id"] == "ab9608b3af968da56"
    assert info["claude_session_id"] == "36c573e0-acfb-47e2-98ca-d9dedd1b608f"


def test_extract_no_marker():
    f = _flow_with_request_body(b"just a regular request body")
    info = subagent.extract(f)
    assert info == {"is_subagent": False}


def test_extract_malformed_marker():
    # marker present but missing parenthesised id
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


def test_resolve_parent_links_pairs_parent_to_subagent():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.request.set_content(b"parent prompt")
    parent.response.set_content(
        b'data: {"type":"tool_use","name":"Agent","input":{}}\n\n'
    )

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent x started (cafe1234)",
        session_id="sess-A",
    )

    subagent.resolve_parent_links([parent, child])
    assert child.metadata.get("subagent_parent_id") == parent.id

    j = flow_to_json(child)
    assert j["parent_flow_id"] == parent.id


def test_resolve_parent_links_skips_other_session():
    parent = tflow.tflow(resp=True)
    parent.request.headers["x-claude-code-session-id"] = "sess-A"
    parent.response.set_content(b'"name":"Agent"')

    child = _flow_with_request_body(
        b"SubagentStart hook additional context: Agent x started (abcd)",
        session_id="sess-B",
    )

    subagent.resolve_parent_links([parent, child])
    assert "subagent_parent_id" not in child.metadata
