import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import SettingsPage from "../app/settings";
import WebHome from "../app/web/page";
import { watchForNewBuild } from "./sw-refresh";
import "../app/globals.css";

watchForNewBuild();

if (window.location.pathname.startsWith("/test-agy")) {
  window.location.replace("/api/test-agy/ui");
}

const path = window.location.pathname;
const web = path.startsWith("/web");
const settings = !web && path.startsWith("/settings");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{web ? <WebHome /> : settings ? <SettingsPage /> : <Home />}</StrictMode>,
);
