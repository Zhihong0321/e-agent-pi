import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import SettingsPage from "../app/settings";
import { watchForNewBuild } from "./sw-refresh";
import "../app/globals.css";

watchForNewBuild();

if (window.location.pathname.startsWith("/test-agy")) {
  window.location.replace("/api/test-agy/ui");
}

const settings = window.location.pathname.startsWith("/settings");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{settings ? <SettingsPage /> : <Home />}</StrictMode>,
);
