import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root が見つかりません");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
