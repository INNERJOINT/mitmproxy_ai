import * as React from "react";
import { OptionsToggle } from "./MenuToggle";

CaptureMenu.title = "Capture";

export default function CaptureMenu() {
    return (
        <div className="menu-group">
            <div className="menu-content">
                <OptionsToggle name="web_capture">Capture flows</OptionsToggle>
            </div>
            <div className="menu-legend">Capture Options</div>
        </div>
    );
}
