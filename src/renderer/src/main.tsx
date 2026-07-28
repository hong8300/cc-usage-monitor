import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { MiniPanel } from "./MiniPanel.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root が見つかりません");

// 同じレンダラをメインパネルとミニウィンドウで共有し、ハッシュで切り替える。
const isMini = window.location.hash === "#mini";
if (isMini) document.body.classList.add("mini");

createRoot(container).render(
  <React.StrictMode>{isMini ? <MiniPanel /> : <App />}</React.StrictMode>,
);
