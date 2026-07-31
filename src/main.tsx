import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { installProxyFetch } from "./utils/proxy-fetch";

// Route fetch() calls for easyeda.com and the model CDN through the
// same-origin /api/proxy endpoint. Those hosts don't return CORS headers, so
// any direct fetch from the browser is blocked by the CORS check.
installProxyFetch();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
