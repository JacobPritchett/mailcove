import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { initTheme } from "./lib/theme";
import { registerServiceWorker } from "./lib/pwa";
import "./index.css";

// Apply the resolved theme before first paint to avoid a light→dark flash.
initTheme();

// Register the PWA service worker (offline shell + push). No-op in dev.
registerServiceWorker();

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
