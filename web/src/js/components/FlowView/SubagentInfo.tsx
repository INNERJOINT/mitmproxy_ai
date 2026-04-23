import * as React from "react";
import { useAppDispatch, useAppSelector } from "../../ducks";
import { select } from "../../ducks/flows";
import type { Flow } from "../../flow";

function typesMatch(a: string | null | undefined, b: string | null | undefined) {
    if (!a || !b) return false;
    const aa = a.split(":").pop()!.trim().toLowerCase();
    const bb = b.split(":").pop()!.trim().toLowerCase();
    return aa.length > 0 && aa === bb;
}

export default function SubagentInfo({ flow }: { flow: Flow }) {
    const dispatch = useAppDispatch();
    const allFlows = useAppSelector((state) => state.flows.list);
    const [showCandidates, setShowCandidates] = React.useState(false);

    const visible =
        flow.is_subagent || flow.claude_session_id || flow.is_launcher;
    if (!visible) return <></>;

    const peers = flow.subagent_instance_id
        ? allFlows.filter(
              (f) =>
                  f.id !== flow.id &&
                  f.subagent_instance_id === flow.subagent_instance_id,
          )
        : [];

    const parent = flow.parent_flow_id
        ? allFlows.find((f) => f.id === flow.parent_flow_id)
        : undefined;

    const candidateParents = React.useMemo(() => {
        if (!flow.is_orphan || !flow.subagent_type) return [];
        const startTime = flow.timestamp_created ?? 0;
        return allFlows
            .filter(
                (f) =>
                    f.is_launcher &&
                    f.id !== flow.id &&
                    (f.child_subagent_runs ?? []).every(
                        (r) => r.instance_id !== flow.subagent_instance_id,
                    ) &&
                    (f.subagent_launches ?? []).some((l) =>
                        typesMatch(l.subagent_type, flow.subagent_type),
                    ),
            )
            .map((f) => ({
                flow: f,
                delta: Math.abs((f.timestamp_created ?? 0) - startTime),
            }))
            .sort((a, b) => a.delta - b.delta);
    }, [allFlows, flow]);

    return (
        <>
            <h4>Claude Code</h4>
            <table className="connection-table">
                <tbody>
                    {flow.claude_session_id && (
                        <tr>
                            <td>Session ID:</td>
                            <td>{flow.claude_session_id}</td>
                        </tr>
                    )}
                    {flow.is_launcher && (
                        <tr>
                            <td>Role:</td>
                            <td>Subagent launcher</td>
                        </tr>
                    )}
                    {flow.is_subagent && (
                        <tr>
                            <td>Subagent:</td>
                            <td>
                                yes
                                {flow.is_orphan && (
                                    <span
                                        style={{
                                            marginLeft: 6,
                                            padding: "1px 6px",
                                            background: "#e07b00",
                                            color: "#fff",
                                            borderRadius: 3,
                                            fontSize: "0.85em",
                                        }}
                                    >
                                        orphan
                                    </span>
                                )}
                            </td>
                        </tr>
                    )}
                    {flow.subagent_type && (
                        <tr>
                            <td>Agent type:</td>
                            <td>{flow.subagent_type}</td>
                        </tr>
                    )}
                    {flow.subagent_instance_id && (
                        <tr>
                            <td>Instance ID:</td>
                            <td>{flow.subagent_instance_id}</td>
                        </tr>
                    )}
                    {parent && (
                        <tr>
                            <td>Parent flow:</td>
                            <td>
                                <a
                                    href="#"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        dispatch(select([parent]));
                                    }}
                                >
                                    {parent.id.slice(0, 8)} (jump)
                                </a>
                            </td>
                        </tr>
                    )}
                    {flow.is_orphan && (
                        <tr>
                            <td>Parent flow:</td>
                            <td>
                                <em>Not in capture.</em>{" "}
                                <a
                                    href="#"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setShowCandidates((v) => !v);
                                    }}
                                >
                                    {showCandidates
                                        ? "Hide candidates"
                                        : `Find candidate parents (${candidateParents.length})`}
                                </a>
                                {showCandidates && (
                                    <div style={{ marginTop: 4 }}>
                                        {candidateParents.length === 0 && (
                                            <em>
                                                No launcher with matching agent
                                                type in capture.
                                            </em>
                                        )}
                                        {candidateParents.map(({ flow: f }) => (
                                            <div
                                                key={f.id}
                                                onClick={() =>
                                                    dispatch(select([f]))
                                                }
                                                style={{ cursor: "pointer" }}
                                            >
                                                {f.id.slice(0, 8)} (
                                                {(f.subagent_launches ?? [])
                                                    .map(
                                                        (l) =>
                                                            l.subagent_type ??
                                                            "?",
                                                    )
                                                    .join(", ")}
                                                )
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </td>
                        </tr>
                    )}
                    {flow.is_launcher &&
                        (flow.child_subagent_runs ?? []).length > 0 && (
                            <tr>
                                <td>Spawned subagents:</td>
                                <td>
                                    {(flow.child_subagent_runs ?? []).map(
                                        (run) => {
                                            const first = allFlows.find(
                                                (f) =>
                                                    f.id === run.flow_ids[0],
                                            );
                                            return (
                                                <div
                                                    key={run.instance_id}
                                                    onClick={() => {
                                                        if (first)
                                                            dispatch(
                                                                select([first]),
                                                            );
                                                    }}
                                                    style={{ cursor: "pointer" }}
                                                >
                                                    {run.subagent_type} ·{" "}
                                                    {run.instance_id.slice(0, 8)}{" "}
                                                    ({run.flow_ids.length} flow
                                                    {run.flow_ids.length === 1
                                                        ? ""
                                                        : "s"}
                                                    )
                                                </div>
                                            );
                                        },
                                    )}
                                </td>
                            </tr>
                        )}
                    {peers.length > 0 && (
                        <tr>
                            <td>Peer subagent flows:</td>
                            <td>
                                {peers.map((p) => (
                                    <div
                                        key={p.id}
                                        onClick={() => dispatch(select([p]))}
                                        style={{ cursor: "pointer" }}
                                    >
                                        {p.id.slice(0, 8)}
                                    </div>
                                ))}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </>
    );
}
SubagentInfo.displayName = "SubagentInfo";
