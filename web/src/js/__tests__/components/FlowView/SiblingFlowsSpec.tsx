import * as React from "react";
import { act, fireEvent, render } from "../../test-utils";
import { TStore, TFlow } from "../../ducks/tutils";
import SiblingFlows from "../../../components/FlowView/SiblingFlows";
import { selectSiblingFlows } from "../../../ducks/flows/selectors";
import {
    FLOWS_ADD,
    FLOWS_RECEIVE,
    FLOWS_REMOVE,
    select,
} from "../../../ducks/flows";
import { FilterName } from "../../../ducks/ui/filter";
import type { HTTPFlow } from "../../../flow";

function makeFlow(
    id: string,
    path: string,
    clientConnId: string,
    timestamp_start: number,
): HTTPFlow {
    const f = TFlow();
    f.id = id;
    f.request.path = path;
    f.request.timestamp_start = timestamp_start;
    f.client_conn = { ...f.client_conn, id: clientConnId };
    return f;
}

function seed(
    store: ReturnType<typeof TStore>,
    flows: HTTPFlow[],
    currentIdx: number,
) {
    store.dispatch(FLOWS_RECEIVE(flows));
    store.dispatch(select([flows[currentIdx]]));
}

describe("SiblingFlows", () => {
    test("renders rows for siblings sharing client_conn.id (current highlighted)", () => {
        const store = TStore(null);
        const cc = "conn-1";
        const f0 = makeFlow("a", "/a", cc, 100);
        const f1 = makeFlow("b", "/b", cc, 101);
        const f2 = makeFlow("c", "/c", cc, 102);
        seed(store, [f0, f1, f2], 1);

        const { container, queryAllByRole } = render(
            <SiblingFlows flow={f1} />,
            { store },
        );
        const rows = queryAllByRole("row");
        expect(rows).toHaveLength(3);
        expect(container.querySelectorAll(".sibling-current")).toHaveLength(1);
        expect(
            container.querySelector(".sibling-current")?.textContent,
        ).toContain("/b");
    });

    test("clicking a non-current row dispatches select", () => {
        const store = TStore(null);
        const cc = "conn-2";
        const f0 = makeFlow("a", "/a", cc, 100);
        const f1 = makeFlow("b", "/b", cc, 101);
        seed(store, [f0, f1], 0);

        const { getByTitle } = render(<SiblingFlows flow={f0} />, { store });
        fireEvent.click(getByTitle("http://address/b"));
        expect(store.getState().flows.selected[0].id).toBe("b");
    });

    test("single-flow connection still renders one highlighted row", () => {
        const store = TStore(null);
        const cc = "conn-3";
        const f0 = makeFlow("a", "/a", cc, 100);
        seed(store, [f0], 0);

        const { container, queryAllByRole } = render(
            <SiblingFlows flow={f0} />,
            { store },
        );
        expect(queryAllByRole("row")).toHaveLength(1);
        expect(container.querySelectorAll(".sibling-current")).toHaveLength(1);
    });

    test("sort order: timestamp_start asc, tiebreak by id", () => {
        const store = TStore(null);
        const cc = "conn-4";
        const f0 = makeFlow("z", "/z", cc, 100);
        const f1 = makeFlow("a", "/a", cc, 100); // same time
        const f2 = makeFlow("m", "/m", cc, 50); // earliest
        seed(store, [f0, f1, f2], 0);

        const siblings = selectSiblingFlows(store.getState());
        expect(siblings.map((f) => f.id)).toEqual(["m", "a", "z"]);
    });

    test("list-vs-view isolation: siblings hidden by filter still appear", () => {
        const store = TStore(null);
        const cc = "conn-5";
        const f0 = makeFlow("a", "/a", cc, 100);
        const f1 = makeFlow("b", "/b", cc, 101);
        seed(store, [f0, f1], 0);

        const { queryAllByRole } = render(<SiblingFlows flow={f0} />, {
            store,
        });

        // Apply a search filter that matches only f0 -- f1 is in list but not view.
        act(() => {
            store.dispatch({
                type: "flows/filterUpdate",
                payload: {
                    name: FilterName.Search,
                    matching_flow_ids: ["a"],
                },
            });
        });
        expect(store.getState().flows.view).toHaveLength(1);
        // Still shows both siblings (reads list, not view).
        expect(queryAllByRole("row")).toHaveLength(2);
    });

    test("dynamic add: new sibling appears", () => {
        const store = TStore(null);
        const cc = "conn-6";
        const f0 = makeFlow("a", "/a", cc, 100);
        seed(store, [f0], 0);

        const { queryAllByRole, rerender } = render(
            <SiblingFlows flow={f0} />,
            { store },
        );
        expect(queryAllByRole("row")).toHaveLength(1);

        const f1 = makeFlow("b", "/b", cc, 101);
        act(() => {
            store.dispatch(
                FLOWS_ADD({
                    flow: f1,
                    matching_filters: {},
                }),
            );
        });
        rerender(<SiblingFlows flow={f0} />);
        expect(queryAllByRole("row")).toHaveLength(2);
    });

    test("dynamic remove: list shrinks by 1", () => {
        const store = TStore(null);
        const cc = "conn-7";
        const f0 = makeFlow("a", "/a", cc, 100);
        const f1 = makeFlow("b", "/b", cc, 101);
        seed(store, [f0, f1], 0);

        const { queryAllByRole, rerender } = render(
            <SiblingFlows flow={f0} />,
            { store },
        );
        expect(queryAllByRole("row")).toHaveLength(2);

        act(() => {
            store.dispatch(FLOWS_REMOVE("b"));
        });
        rerender(<SiblingFlows flow={f0} />);
        expect(queryAllByRole("row")).toHaveLength(1);
    });
});
