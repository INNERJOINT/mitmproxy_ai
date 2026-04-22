import * as React from "react";
import classnames from "classnames";
import { useAppDispatch, useAppSelector } from "../../ducks";
import { select } from "../../ducks/flows";
import { selectSiblingFlows } from "../../ducks/flows/selectors";
import type { Flow } from "../../flow";

function flowLabel(flow: Flow): { left: string; right: string } {
    if (flow.type === "http") {
        const req = flow.request;
        const url = `${req.scheme}://${req.pretty_host}${req.path}`;
        return { left: req.method, right: url };
    }
    if (flow.type === "dns") {
        const name = flow.request?.questions?.[0]?.name ?? flow.id;
        return { left: "DNS", right: name };
    }
    return { left: flow.type.toUpperCase(), right: flow.id };
}

export default function SiblingFlows({ flow }: { flow: Flow }) {
    const dispatch = useAppDispatch();
    const siblings = useAppSelector(selectSiblingFlows);

    if (siblings.length === 0) return <></>;

    return (
        <>
            <h4>Sibling Flows on This Connection</h4>
            <div className="sibling-flows-table">
                <table>
                    <tbody>
                        {siblings.map((sibling) => {
                            const { left, right } = flowLabel(sibling);
                            const isCurrent = sibling.id === flow.id;
                            return (
                                <tr
                                    key={sibling.id}
                                    className={classnames({
                                        "sibling-current": isCurrent,
                                    })}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            dispatch(select([sibling]));
                                        }
                                    }}
                                >
                                    <td>{left}</td>
                                    <td title={right}>{right}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}
SiblingFlows.displayName = "SiblingFlows";
