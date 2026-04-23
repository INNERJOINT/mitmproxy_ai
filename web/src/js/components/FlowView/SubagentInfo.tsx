import * as React from "react";
import { useAppDispatch, useAppSelector } from "../../ducks";
import { select } from "../../ducks/flows";
import type { Flow } from "../../flow";

export default function SubagentInfo({ flow }: { flow: Flow }) {
    const dispatch = useAppDispatch();
    const allFlows = useAppSelector((state) => state.flows.list);

    if (!flow.is_subagent && !flow.claude_session_id) return <></>;

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
                    <tr>
                        <td>Subagent:</td>
                        <td>{flow.is_subagent ? "yes" : "no"}</td>
                    </tr>
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
