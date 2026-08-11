import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { setAccessToken } from "./lib/api";
import "./index.css";

const bootstrapParams = new URLSearchParams(window.location.search);
const bootstrapToken = bootstrapParams.get("accessToken")?.trim();
if (bootstrapToken) {
  setAccessToken(bootstrapToken);
  bootstrapParams.delete("accessToken");
  const next = `${window.location.pathname}${bootstrapParams.toString() ? `?${bootstrapParams}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", next);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
