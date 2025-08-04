/** @jsxImportSource https://esm.sh/react */
import React from "https://esm.sh/react";
import { createRoot } from "https://esm.sh/react-dom/client";
import { App } from "./components/App.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
