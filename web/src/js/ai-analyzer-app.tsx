import * as React from "react";
import { createRoot } from "react-dom/client";
import AIAnalyzerPage from "./components/AIAnalyzerPage";

document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("ai-analyzer-root");
    if (container) {
        const root = createRoot(container);
        root.render(<AIAnalyzerPage />);
    } else {
        console.error("Could not find ai-analyzer-root element.");
    }
});
