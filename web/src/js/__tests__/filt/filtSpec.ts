import Filt from "../../filt/filt";

const baseFlow = {
    id: "f1",
    type: "http",
    intercepted: false,
    is_replay: undefined,
    modified: false,
    marked: "",
    comment: "",
    timestamp_created: 0,
    client_conn: { peername: ["1.1.1.1", 0] },
    request: { host: "x", pretty_host: "x", method: "GET", path: "/" },
};

describe("filt grammar - subagent atoms", () => {
    test("~subagent matches subagent flow", () => {
        const f = Filt.parse("~subagent");
        expect(f({ ...baseFlow, is_subagent: true })).toBe(true);
        expect(f({ ...baseFlow, is_subagent: false })).toBe(false);
        expect(f({ ...baseFlow })).toBe(false);
    });

    test("~agentid matches exact instance id", () => {
        const f = Filt.parse("~agentid ab9608b3af968da56");
        expect(
            f({
                ...baseFlow,
                is_subagent: true,
                subagent_instance_id: "ab9608b3af968da56",
            }),
        ).toBe(true);
        expect(
            f({
                ...baseFlow,
                is_subagent: true,
                subagent_instance_id: "different",
            }),
        ).toBe(false);
        expect(f({ ...baseFlow })).toBe(false);
    });

    test("~agentid description includes id", () => {
        expect(Filt.parse("~agentid abc").desc).toContain("abc");
    });
});
