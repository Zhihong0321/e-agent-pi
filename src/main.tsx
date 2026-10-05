import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MobileHome from "../app/page";
import SettingsPage from "../app/settings";
import SigninPage from "../app/signin/page";
import WebHome from "../app/web/page";
import DemoPage from "../app/demo/page";
import CalendarPage from "../app/calendar";
import MediaKitPage from "../app/media-kit";
import ResearchPage from "../app/research";
import SignalsPage from "../app/signals";
import { watchForNewBuild } from "./sw-refresh";
import "../app/globals.css";

watchForNewBuild();

const path = window.location.pathname;
const root = ["/", "/root", "/root/", "/index.html"].includes(path);
const mobile = path === "/mobile" || path.startsWith("/mobile/");
// Device signals keep a resized desktop window on the desktop front door.
const browserNavigator = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
const mobileDevice = browserNavigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  || (navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 820px) and (pointer: coarse)").matches);
const signals = path === "/signals" || path.startsWith("/signals/") || path === "/signal-reports" || path.startsWith("/signal-reports");
const research = path === "/research" || path.startsWith("/research/");
const web = path.startsWith("/web");
const demo = path === "/demo" || path.startsWith("/demo/");
const calendar = path === "/calendar" || path.startsWith("/calendar/");
const mediaKit = path === "/media-kit" || path.startsWith("/media-kit/");
const settings = !web && !demo && !calendar && !mediaKit && !signals && path.startsWith("/settings");
const signin = !web && !demo && !calendar && !mediaKit && !settings && !signals && path.startsWith("/signin");

if (path.startsWith("/test-agy")) {
  window.location.replace("/api/test-agy/ui");
} else if (root && !mobileDevice) {
  window.location.replace(`/demo${window.location.search}${window.location.hash}`);
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>{mobile || (root && mobileDevice) ? <MobileHome /> : signals ? <SignalsPage /> : research ? <ResearchPage /> : mediaKit ? <MediaKitPage /> : calendar ? <CalendarPage /> : demo ? <DemoPage /> : web ? <WebHome /> : settings ? <SettingsPage /> : signin ? <SigninPage /> : <DemoPage />}</StrictMode>,
  );
}
