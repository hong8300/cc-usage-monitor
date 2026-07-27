/// <reference types="vite/client" />

import type { MonitorApi } from "../../shared/ipc.ts";

declare global {
  interface Window {
    monitor: MonitorApi;
  }
}

export {};
