// The stylesheets come first and they come from here, before anything that renders is imported.
// Order matters and modules are evaluated in the order they are written, so a component importing
// its own sheet would put that sheet in front of the tokens it resolves against. This is the whole
// chain and the only place any of it is loaded.
//
// Tokens declare every custom property, fonts bind the families the tokens name, and app.css is the
// first sheet allowed to depend on both. The rest layer on top of app.css and each other in the
// order their rules expect to win: the document's typography, then the three block sheets that
// answer it for a construct with a node view or a decoration of its own, then the page the document
// sits on and the section drawn under the end of it, the pill that floats over that page and the
// three menus that hang off the title bar, and last the shell, which is the one sheet that reaches
// back into the title bar app.css already styled. The palettes come last of all: they override .overlay from
// app.css and .key-cap from tree.css, so they have to be able to see both.
//
// katex.min.css is not here. src/editor/blocks/math.ts imports it itself so that the bundler
// rewrites its font URLs into the bundle, which the app's CSP requires.
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/app.css";
import "./styles/prose.css";
import "./styles/code.css";
import "./styles/math.css";
import "./styles/mermaid.css";
import "./styles/proofing.css";
import "./styles/sheet.css";
import "./styles/backlinks.css";
import "./styles/toolbar.css";
import "./styles/width-menu.css";
import "./styles/document-setup.css";
import "./styles/export-preview.css";
import "./styles/link-picker.css";
import "./styles/tree.css";
import "./styles/palette.css";
import "./styles/settings.css";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isMacDesktop } from "./ipc";

// The traffic lights only float over the page on a macOS desktop window, so the lane the title bar
// leaves for them opens off an attribute rather than a user agent sniff inside the stylesheet.
if (isMacDesktop) document.documentElement.setAttribute("data-traffic", "");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
