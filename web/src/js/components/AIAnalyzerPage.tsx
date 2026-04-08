import React, { useEffect, useState, useMemo } from "react";
import { fetchApi } from "../utils";
import { parseSingleWsMessage } from "./Modal/ai-parsers";
import type { AIAnalyzerEvent, WsMessage } from "./Modal/ai-parsers/types";

export default function AIAnalyzerPage() {
    const [rawMessages, setRawMessages] = useState<WsMessage[]>([]);
    const [flowMeta, setFlowMeta] = useState<any>(null);
    const [selectedMessageIndex, setSelectedMessageIndex] = useState<
        number | null
    >(null);
    const [selectedPath, setSelectedPath] = useState<(string | number)[]>([]); // path array

    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [filterDirection, setFilterDirection] = useState<
        "all" | "incoming" | "outgoing"
    >("all");
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [flowId, setFlowId] = useState<string | null>(null);

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const id = urlParams.get("flow_id");
        if (!id) {
            setError("No flow_id provided in the URL.");
            setLoading(false);
            return;
        }
        setFlowId(id);

        const fetchData = async () => {
            try {
                // 1. Fetch flow metadata to determine if it's HTTP or WebSocket
                const flowRes = await fetchApi("/flows");
                const flows = await flowRes.json();
                const match = flows.find((f: any) => f.id === id);
                if (!match) {
                    throw new Error(`Flow ${id} not found.`);
                }
                setFlowMeta(match);

                // 2. Fetch messages based on flow type
                if (match.websocket) {
                    // Original WS fetching logic (HTTP flow upgraded to WebSocket)
                    const response = await fetchApi(
                        `/flows/${id}/messages/content/raw.json`,
                    );
                    if (response.status !== 200) {
                        throw new Error(
                            `Error fetching messages: ${response.status}`,
                        );
                    }
                    const data = await response.json();
                    setRawMessages(data);
                } else if (match.type === "http") {
                    // Fetch HTTP Request and Response bodies
                    const reqRes = await fetchApi(
                        `/flows/${id}/request/content.data`,
                    );
                    const reqText = await reqRes.text();

                    const respRes = await fetchApi(
                        `/flows/${id}/response/content.data`,
                    );
                    const respText = await respRes.text();

                    // Mock them as WsMessage objects
                    const mockMessages: WsMessage[] = [
                        {
                            content: reqText, // Keep 'content' inside the component just in case, or rather just use text
                            text: reqText,
                            from_client: true,
                            timestamp:
                                match.request?.timestamp_start ||
                                Date.now() / 1000,
                        } as any, // Cast as any if 'content' throws error, actually WsMessage only has text, from_client, timestamp
                        {
                            content: respText,
                            text: respText,
                            from_client: false,
                            timestamp:
                                match.response?.timestamp_start ||
                                Date.now() / 1000,
                        } as any,
                    ];
                    setRawMessages(mockMessages);
                } else {
                    throw new Error(
                        `Flow type ${match.type} is not supported for AI Analysis.`,
                    );
                }

                // We purposely leave selectedMessageIndex as null so the overview is shown first!
            } catch (err: any) {
                setError(err.message || "Failed to load messages");
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const filteredMessages = useMemo(() => {
        return rawMessages
            .map((msg, index) => ({ msg, index }))
            .filter(({ msg }) => {
                const dir = msg.from_client ? "outgoing" : "incoming";
                if (filterDirection !== "all" && dir !== filterDirection)
                    return false;

                if (!searchQuery) return true;
                const q = searchQuery.toLowerCase();
                return msg.text.toLowerCase().includes(q);
            });
    }, [rawMessages, filterDirection, searchQuery]);

    const handleSelectMessage = (index: number) => {
        if (selectedMessageIndex !== index) {
            setSelectedMessageIndex(index);
            setSelectedPath([]); // Reset path when switching messages
        } else {
            // Deselect to go back to Overview
            setSelectedMessageIndex(null);
            setSelectedPath([]);
        }
    };

    const renderChatEvent = (event: AIAnalyzerEvent, index: number) => {
        let content: React.ReactNode = null;

        if (event.type === "system_prompt" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong
                        style={{
                            display: "block",
                            marginBottom: "5px",
                            color: "#333",
                        }}
                    >
                        Instructions / Prompt
                    </strong>
                    <pre
                        style={{
                            whiteSpace: "pre-wrap",
                            background: "#f5f5f5",
                            padding: "10px",
                            border: "1px solid #e3e3e3",
                            borderRadius: "4px",
                            margin: 0,
                        }}
                    >
                        {event.content}
                    </pre>
                </div>
            );
        } else if (event.type === "assistant_stream" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong
                        style={{
                            display: "block",
                            marginBottom: "5px",
                            color: "#333",
                        }}
                    >
                        Text Delta
                    </strong>
                    <div
                        style={{
                            whiteSpace: "pre-wrap",
                            background: "#f9f9f9",
                            padding: "10px",
                            border: "1px solid #e3e3e3",
                            borderRadius: "4px",
                            fontFamily: "monospace",
                        }}
                    >
                        {event.content}
                    </div>
                </div>
            );
        } else if (event.type === "user_message" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong
                        style={{
                            display: "block",
                            marginBottom: "5px",
                            color: "#333",
                        }}
                    >
                        User Message
                    </strong>
                    <div
                        style={{
                            whiteSpace: "pre-wrap",
                            padding: "10px",
                            background: "#fff",
                            border: "1px solid #e3e3e3",
                            borderRadius: "4px",
                        }}
                    >
                        {event.content}
                    </div>
                </div>
            );
        } else if (event.type === "meta" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong style={{ color: "#333" }}>Meta Info:</strong>
                    <span
                        className="text-muted"
                        style={{ whiteSpace: "pre-wrap", marginLeft: "5px" }}
                    >
                        {event.content}
                    </span>
                </div>
            );
        } else if (event.type === "tool_call" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong
                        style={{
                            display: "block",
                            marginBottom: "5px",
                            color: "#0d6efd",
                        }}
                    >
                        Tool Call
                    </strong>
                    <pre
                        style={{
                            whiteSpace: "pre-wrap",
                            background: "#f0f4ff",
                            padding: "10px",
                            border: "1px solid #b8cfff",
                            borderRadius: "4px",
                            margin: 0,
                            fontFamily: "monospace",
                        }}
                    >
                        {event.content}
                    </pre>
                </div>
            );
        } else if (event.type === "tool_result" && event.content) {
            content = (
                <div style={{ marginBottom: "15px" }}>
                    <strong
                        style={{
                            display: "block",
                            marginBottom: "5px",
                            color: "#198754",
                        }}
                    >
                        Tool Result
                    </strong>
                    <pre
                        style={{
                            whiteSpace: "pre-wrap",
                            background: "#f0faf4",
                            padding: "10px",
                            border: "1px solid #b8e6cc",
                            borderRadius: "4px",
                            margin: 0,
                            fontFamily: "monospace",
                        }}
                    >
                        {event.content}
                    </pre>
                </div>
            );
        }

        if (!content) return null;

        return <div key={index}>{content}</div>;
    };

    const renderOverview = () => {
        if (rawMessages.length === 0) {
            return (
                <div
                    style={{
                        padding: "40px",
                        color: "#888",
                        textAlign: "center",
                    }}
                >
                    No messages recorded in this flow.
                </div>
            );
        }

        const startTime = new Date(
            rawMessages[0].timestamp * 1000,
        ).toLocaleString();
        const endTime = new Date(
            rawMessages[rawMessages.length - 1].timestamp * 1000,
        ).toLocaleString();

        const combinedChat: { role: string; content: string }[] = [];

        for (const msg of rawMessages) {
            const events = parseSingleWsMessage(msg);
            for (const ev of events) {
                if (ev.type === "system_prompt") {
                    combinedChat.push({
                        role: "System Prompt",
                        content: ev.content || "",
                    });
                } else if (ev.type === "user_message") {
                    combinedChat.push({
                        role: "User",
                        content: ev.content || "",
                    });
                } else if (ev.type === "assistant_stream") {
                    if (
                        combinedChat.length > 0 &&
                        combinedChat[combinedChat.length - 1].role ===
                            "Assistant"
                    ) {
                        combinedChat[combinedChat.length - 1].content +=
                            ev.content;
                    } else {
                        combinedChat.push({
                            role: "Assistant",
                            content: ev.content || "",
                        });
                    }
                } else if (ev.type === "tool_call") {
                    combinedChat.push({
                        role: "Tool Call",
                        content: ev.content || "",
                    });
                } else if (ev.type === "tool_result") {
                    combinedChat.push({
                        role: "Tool Result",
                        content: ev.content || "",
                    });
                }
            }
        }

        const getUrl = () => {
            if (!flowMeta || !flowMeta.request) return "Unknown URL";
            return `${flowMeta.request.scheme}://${flowMeta.request.host}${flowMeta.request.port === 443 ? "" : ":" + flowMeta.request.port}${flowMeta.request.path}`;
        };

        return (
            <div
                style={{
                    padding: "30px",
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    overflowY: "auto",
                    boxSizing: "border-box",
                    background: "#fff",
                }}
            >
                <h2
                    style={{
                        marginTop: 0,
                        marginBottom: "25px",
                        color: "#333",
                        fontSize: "22px",
                        borderBottom: "2px solid #eee",
                        paddingBottom: "10px",
                    }}
                >
                    Flow Overview
                </h2>

                <div
                    style={{
                        background: "#f8f9fa",
                        padding: "20px",
                        borderRadius: "8px",
                        border: "1px solid #e9ecef",
                        marginBottom: "30px",
                    }}
                >
                    <h3
                        style={{
                            marginTop: 0,
                            fontSize: "16px",
                            marginBottom: "15px",
                            color: "#495057",
                        }}
                    >
                        Connection Details
                    </h3>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "120px 1fr",
                            gap: "12px",
                            fontSize: "14px",
                        }}
                    >
                        <span style={{ color: "#6c757d", fontWeight: "bold" }}>
                            Flow ID:
                        </span>{" "}
                        <span
                            style={{
                                fontFamily: "monospace",
                                color: "#212529",
                            }}
                        >
                            {flowId}
                        </span>
                        <span style={{ color: "#6c757d", fontWeight: "bold" }}>
                            Endpoint:
                        </span>{" "}
                        <span
                            style={{ wordBreak: "break-all", color: "#0056b3" }}
                        >
                            {getUrl()}
                        </span>
                        {flowMeta && flowMeta.client_conn && (
                            <>
                                <span
                                    style={{
                                        color: "#6c757d",
                                        fontWeight: "bold",
                                    }}
                                >
                                    Client IP:
                                </span>{" "}
                                <span>{flowMeta.client_conn.peername[0]}</span>
                            </>
                        )}
                        <span style={{ color: "#6c757d", fontWeight: "bold" }}>
                            Messages:
                        </span>{" "}
                        <span>{rawMessages.length} total messages</span>
                        <span style={{ color: "#6c757d", fontWeight: "bold" }}>
                            Duration:
                        </span>{" "}
                        <span>
                            {startTime} &mdash; {endTime}
                        </span>
                    </div>
                </div>

                <h3
                    style={{
                        fontSize: "18px",
                        color: "#333",
                        marginBottom: "20px",
                    }}
                >
                    Complete Conversation Transcript
                </h3>
                <div
                    style={{
                        background: "#fff",
                        padding: "0",
                        borderRadius: "8px",
                    }}
                >
                    {combinedChat.length === 0 ? (
                        <div
                            style={{
                                color: "#888",
                                textAlign: "center",
                                padding: "40px",
                                background: "#f8f9fa",
                                borderRadius: "8px",
                                border: "1px dashed #ced4da",
                            }}
                        >
                            No text-based dialogue could be extracted. Select
                            individual messages on the left to inspect raw
                            payloads.
                        </div>
                    ) : (
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "20px",
                            }}
                        >
                            {combinedChat.map((chat, idx) => {
                                const isUser = chat.role === "User";
                                const isSystem = chat.role === "System Prompt";
                                const isToolCall = chat.role === "Tool Call";
                                const isToolResult = chat.role === "Tool Result";
                                const isTool = isToolCall || isToolResult;
                                return (
                                    <div
                                        key={idx}
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: isUser
                                                ? "flex-end"
                                                : "flex-start",
                                        }}
                                    >
                                        <span
                                            style={{
                                                fontSize: "12px",
                                                color: "#888",
                                                marginBottom: "4px",
                                                marginLeft: isUser
                                                    ? "0"
                                                    : "10px",
                                                marginRight: isUser
                                                    ? "10px"
                                                    : "0",
                                                fontWeight: "bold",
                                            }}
                                        >
                                            {chat.role}
                                        </span>
                                        <div
                                            style={{
                                                background: isUser
                                                    ? "#007bff"
                                                    : isSystem
                                                      ? "#e9ecef"
                                                      : isToolCall
                                                        ? "#f0f4ff"
                                                        : isToolResult
                                                          ? "#f0faf4"
                                                          : "#f1f3f5",
                                                color: isUser
                                                    ? "#fff"
                                                    : "#212529",
                                                padding: "12px 16px",
                                                borderRadius: "12px",
                                                borderTopRightRadius: isUser
                                                    ? "0"
                                                    : "12px",
                                                borderTopLeftRadius: isUser
                                                    ? "12px"
                                                    : "0",
                                                maxWidth: "85%",
                                                boxShadow:
                                                    "0 1px 2px rgba(0,0,0,0.05)",
                                                whiteSpace: "pre-wrap",
                                                fontSize: "14px",
                                                lineHeight: "1.5",
                                                border: isToolCall
                                                    ? "1px solid #b8cfff"
                                                    : isToolResult
                                                      ? "1px solid #b8e6cc"
                                                      : "none",
                                                fontFamily: isTool
                                                    ? "monospace"
                                                    : "inherit",
                                            }}
                                        >
                                            {chat.content}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderRightPane = () => {
        if (
            selectedMessageIndex === null ||
            !rawMessages[selectedMessageIndex]
        ) {
            return renderOverview();
        }

        const msg = rawMessages[selectedMessageIndex];
        const parsedEvents = parseSingleWsMessage(msg);
        const isClient = msg.from_client;

        let parsedJson: any = null;
        try {
            parsedJson = JSON.parse(msg.text);
        } catch {
            /* empty */
        }

        // Traverse using selectedPath
        let currentData = parsedJson;
        if (parsedJson !== null) {
            for (const key of selectedPath) {
                if (
                    currentData &&
                    typeof currentData === "object" &&
                    key in currentData
                ) {
                    currentData = currentData[key];
                } else {
                    currentData = undefined;
                    break;
                }
            }
        }

        // Compute keys of currentData to show
        let nextKeys: string[] = [];
        if (
            currentData &&
            typeof currentData === "object" &&
            !Array.isArray(currentData)
        ) {
            nextKeys = Object.keys(currentData);
        } else if (Array.isArray(currentData)) {
            nextKeys = currentData.map((_, i) => String(i));
        }

        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                    boxSizing: "border-box",
                }}
            >
                {/* Header Area */}
                <div
                    style={{
                        padding: "20px",
                        paddingBottom: "10px",
                        borderBottom: "1px solid #eee",
                        background: "#fcfcfc",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                        }}
                    >
                        <div>
                            <span
                                className={`label ${isClient ? "label-primary" : "label-danger"}`}
                                style={{ fontSize: "12px", padding: "4px 8px" }}
                            >
                                {isClient
                                    ? "Outgoing (Client)"
                                    : "Incoming (Server)"}
                            </span>
                            <span
                                style={{
                                    marginLeft: "10px",
                                    color: "#666",
                                    fontSize: "13px",
                                }}
                            >
                                {new Date(
                                    msg.timestamp * 1000,
                                ).toLocaleString()}
                            </span>
                            {parsedEvents.length > 0 &&
                                parsedEvents[0].provider !== "Unknown" && (
                                    <span
                                        style={{
                                            marginLeft: "10px",
                                            fontWeight: "bold",
                                            color: "#333",
                                        }}
                                    >
                                        {parsedEvents[0].provider} -{" "}
                                        {parsedEvents[0].type}
                                    </span>
                                )}
                        </div>
                    </div>

                    {/* Drill-down UI matching "Raw Payload Data in top right" */}
                    {parsedJson !== null && (
                        <div
                            style={{
                                marginTop: "15px",
                                background: "#f5f5f5",
                                padding: "10px 15px",
                                borderRadius: "6px",
                                border: "1px solid #ddd",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    flexWrap: "wrap",
                                    fontSize: "13px",
                                }}
                            >
                                <strong
                                    style={{
                                        marginRight: "10px",
                                        color: "#555",
                                    }}
                                >
                                    Payload Path:
                                </strong>
                                <span
                                    style={{
                                        cursor: "pointer",
                                        color:
                                            selectedPath.length === 0
                                                ? "#333"
                                                : "#0066cc",
                                        fontWeight:
                                            selectedPath.length === 0
                                                ? "bold"
                                                : "normal",
                                    }}
                                    onClick={() => setSelectedPath([])}
                                >
                                    root
                                </span>
                                {selectedPath.map((seg, idx) => (
                                    <React.Fragment key={idx}>
                                        <span
                                            style={{
                                                margin: "0 5px",
                                                color: "#999",
                                            }}
                                        >
                                            /
                                        </span>
                                        <span
                                            style={{
                                                cursor: "pointer",
                                                color:
                                                    idx ===
                                                    selectedPath.length - 1
                                                        ? "#333"
                                                        : "#0066cc",
                                                fontWeight:
                                                    idx ===
                                                    selectedPath.length - 1
                                                        ? "bold"
                                                        : "normal",
                                            }}
                                            onClick={() =>
                                                setSelectedPath(
                                                    selectedPath.slice(
                                                        0,
                                                        idx + 1,
                                                    ),
                                                )
                                            }
                                        >
                                            {seg}
                                        </span>
                                    </React.Fragment>
                                ))}
                            </div>

                            {/* Children buttons */}
                            {nextKeys.length > 0 && (
                                <div
                                    style={{
                                        marginTop: "10px",
                                        display: "flex",
                                        flexWrap: "wrap",
                                        gap: "6px",
                                    }}
                                >
                                    {nextKeys.map((k) => (
                                        <button
                                            key={k}
                                            onClick={() =>
                                                setSelectedPath([
                                                    ...selectedPath,
                                                    k,
                                                ])
                                            }
                                            style={{
                                                background: "#fff",
                                                border: "1px solid #ccc",
                                                padding: "3px 8px",
                                                borderRadius: "4px",
                                                fontSize: "12px",
                                                cursor: "pointer",
                                                color: "#333",
                                            }}
                                            onMouseOver={(e) =>
                                                (e.currentTarget.style.borderColor =
                                                    "#007bff")
                                            }
                                            onMouseOut={(e) =>
                                                (e.currentTarget.style.borderColor =
                                                    "#ccc")
                                            }
                                        >
                                            {k}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Main Content Area */}
                <div
                    style={{
                        flex: 1,
                        padding: "20px",
                        overflowY: "auto",
                        background: "#fff",
                    }}
                >
                    {selectedPath.length > 0 ? (
                        <div>
                            <strong
                                style={{
                                    display: "block",
                                    marginBottom: "10px",
                                    color: "#333",
                                    fontSize: "15px",
                                }}
                            >
                                Node Content:
                            </strong>
                            <pre
                                style={{
                                    whiteSpace: "pre-wrap",
                                    background: "#fafafa",
                                    padding: "15px",
                                    border: "1px solid #e3e3e3",
                                    borderRadius: "6px",
                                    margin: 0,
                                    fontSize: "13px",
                                }}
                            >
                                {typeof currentData === "object"
                                    ? JSON.stringify(currentData, null, 2)
                                    : String(currentData)}
                            </pre>
                        </div>
                    ) : (
                        <div>
                            {/* Visualized Events Summary */}
                            {parsedEvents.length > 0 &&
                                parsedEvents[0].type !== "unknown" && (
                                    <div
                                        style={{
                                            marginBottom: "20px",
                                            paddingBottom: "10px",
                                            borderBottom: "1px dashed #eee",
                                        }}
                                    >
                                        {parsedEvents.map((event, index) =>
                                            renderChatEvent(event, index),
                                        )}
                                    </div>
                                )}

                            <strong
                                style={{
                                    display: "block",
                                    marginBottom: "10px",
                                    color: "#333",
                                    fontSize: "15px",
                                }}
                            >
                                Complete Message Payload:
                            </strong>
                            <pre
                                style={{
                                    whiteSpace: "pre-wrap",
                                    background: "#252526",
                                    color: "#d4d4d4",
                                    padding: "15px",
                                    borderRadius: "6px",
                                    fontSize: "12px",
                                    border: "1px solid #1e1e1e",
                                    marginTop: 0,
                                }}
                            >
                                {parsedJson
                                    ? JSON.stringify(parsedJson, null, 2)
                                    : msg.text}
                            </pre>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const getMessageSummary = (msg: WsMessage) => {
        try {
            const j = JSON.parse(msg.text);
            return j.type || "JSON Message";
        } catch {
            return msg.text.slice(0, 50) + "...";
        }
    };

    return (
        <div
            style={{
                height: "100vh",
                display: "flex",
                flexDirection: "column",
                fontFamily: "system-ui, -apple-system, sans-serif",
            }}
        >
            <div
                style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid #ddd",
                    background: "#f8f9fa",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                }}
            >
                <h3 style={{ margin: 0, fontSize: "18px" }}>
                    AI API Analyzer{" "}
                    <small
                        style={{
                            color: "#888",
                            fontSize: "14px",
                            marginLeft: "10px",
                        }}
                    >
                        Flow: {flowId}
                    </small>
                </h3>
                <div style={{ display: "flex", gap: "10px" }}>
                    <input
                        type="text"
                        className="form-control input-sm"
                        placeholder="Search Raw Data..."
                        style={{ width: "200px" }}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    <select
                        className="form-control input-sm"
                        style={{ width: "auto" }}
                        value={filterDirection}
                        onChange={(e) =>
                            setFilterDirection(e.target.value as any)
                        }
                    >
                        <option value="all">All Messages</option>
                        <option value="incoming">Incoming</option>
                        <option value="outgoing">Outgoing</option>
                    </select>
                </div>
            </div>

            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
                <div
                    style={{
                        width: "35%",
                        borderRight: "1px solid #ccc",
                        display: "flex",
                        flexDirection: "column",
                        background: "#fff",
                    }}
                >
                    {loading ? (
                        <div style={{ padding: "20px", color: "#666" }}>
                            Loading messages...
                        </div>
                    ) : error ? (
                        <div style={{ padding: "20px", color: "red" }}>
                            {error}
                        </div>
                    ) : filteredMessages.length === 0 ? (
                        <div style={{ padding: "20px", color: "#888" }}>
                            No matching messages found.
                        </div>
                    ) : (
                        <ul
                            style={{
                                listStyle: "none",
                                margin: 0,
                                padding: 0,
                                overflowY: "auto",
                                flex: 1,
                            }}
                        >
                            {/* Allow clicking a back button to see overview */}
                            {selectedMessageIndex !== null && (
                                <li
                                    onClick={() =>
                                        handleSelectMessage(
                                            selectedMessageIndex,
                                        )
                                    }
                                    style={{
                                        padding: "12px 15px",
                                        borderBottom: "1px solid #ccc",
                                        background: "#e9ecef",
                                        cursor: "pointer",
                                        fontWeight: "bold",
                                        textAlign: "center",
                                        color: "#0056b3",
                                    }}
                                >
                                    &larr; Back to Flow Overview
                                </li>
                            )}
                            {filteredMessages.map(({ msg, index }) => {
                                const isSelected =
                                    index === selectedMessageIndex;
                                const isClient = msg.from_client;
                                return (
                                    <li
                                        key={index}
                                        onClick={() =>
                                            handleSelectMessage(index)
                                        }
                                        style={{
                                            padding: "12px 15px",
                                            borderBottom: "1px solid #eee",
                                            cursor: "pointer",
                                            background: isSelected
                                                ? "#e6f2ff"
                                                : "transparent",
                                            borderLeft: isSelected
                                                ? "4px solid #007bff"
                                                : "4px solid transparent",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                justifyContent: "space-between",
                                                marginBottom: "4px",
                                            }}
                                        >
                                            <span
                                                style={{
                                                    fontSize: "12px",
                                                    color: isClient
                                                        ? "#0066cc"
                                                        : "#cc0000",
                                                    fontWeight: "bold",
                                                }}
                                            >
                                                {isClient
                                                    ? "↑ Outgoing"
                                                    : "↓ Incoming"}
                                            </span>
                                            <span
                                                style={{
                                                    fontSize: "11px",
                                                    color: "#999",
                                                }}
                                            >
                                                {new Date(
                                                    msg.timestamp * 1000,
                                                ).toLocaleTimeString()}
                                            </span>
                                        </div>
                                        <div
                                            style={{
                                                fontSize: "14px",
                                                color: "#333",
                                                whiteSpace: "nowrap",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                            }}
                                        >
                                            {getMessageSummary(msg)}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <div
                    style={{
                        width: "65%",
                        background: "#fdfdfd",
                        overflow: "hidden",
                    }}
                >
                    {!loading && !error && renderRightPane()}
                </div>
            </div>
        </div>
    );
}
