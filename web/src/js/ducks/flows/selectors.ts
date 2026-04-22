import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import type { Flow } from "../../flow";

const selectCurrentClientConnId = (state: RootState): string | undefined =>
    state.flows.selected[0]?.client_conn?.id;

const selectFlowsList = (state: RootState): Flow[] => state.flows.list;

function flowTime(f: Flow): number {
    if (f.type === "http" && f.request) {
        return f.request.timestamp_start;
    }
    if (f.type === "dns" && f.request) {
        return f.request.timestamp ?? f.timestamp_created;
    }
    return f.timestamp_created;
}

export const selectSiblingFlows = createSelector(
    [selectFlowsList, selectCurrentClientConnId],
    (list, currentConnId): Flow[] => {
        if (!currentConnId) return [];
        return list
            .filter((f) => f.client_conn.id === currentConnId)
            .sort(
                (a, b) =>
                    flowTime(a) - flowTime(b) || a.id.localeCompare(b.id),
            );
    },
);
