import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import SettingsPage from "../app/settings";
import SigninPage from "../app/signin/page";
import WebHome from "../app/web/page";
import DemoPage from "../app/demo/page";
import CalendarPage from "../app/calendar";
import MediaKitPage from "../app/media-kit";
import { watchForNewBuild } from "./sw-refresh";
import "../app/globals.css";

watchForNewBuild();

if (window.location.pathname.startsWith("/test-agy")) {
  window.location.replace("/api/test-agy/ui");
}

const path = window.location.pathname;
const web = path.startsWith("/web");
const demo = path === "/demo" || path.startsWith("/demo/");
const calendar = path === "/calendar" || path.startsWith("/calendar/");
const mediaKit = path === "/media-kit" || path.startsWith("/media-kit/");
const settings = !web && !demo && !calendar && !mediaKit && path.startsWith("/settings");
const signin = !web && !demo && !calendar && !mediaKit && !settings && path.startsWith("/signin");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{mediaKit ? <MediaKitPage /> : calendar ? <CalendarPage /> : demo ? <DemoPage /> : web ? <WebHome /> : settings ? <SettingsPage /> : signin ? <SigninPage /> : <Home />}</StrictMode>,
);
