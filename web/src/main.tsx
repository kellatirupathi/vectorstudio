import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { setAccessToken } from "./lib/api";
import "./index.css";

// One-time bootstrap: /?accessToken=... stores the token and strips it from the URL.
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
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
