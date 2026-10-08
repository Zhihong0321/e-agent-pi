import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MobileHome from "../app/page";
import SettingsPage from "../app/settings";
import SigninPage from "../app/signin/page";
import WebHome from "../app/web/page";
import DemoPage from "../app/demo/page";
import CalendarPage from "../app/calendar";
import SchedulesPage from '../app/schedules';
import MediaKitPage from "../app/media-kit";
import ResearchPage from "../app/research";
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
const research = path === "/research" || path.startsWith("/research/");
const web = path.startsWith("/web");
const demo = path === "/demo" || path.startsWith("/demo/");
const calendar = path === "/calendar" || path.startsWith("/calendar/");
const schedules = path === '/schedules' || path.startsWith('/schedules/');
const mediaKit = path === "/media-kit" || path.startsWith("/media-kit/");
const admin = path === "/admin" || path.startsWith("/admin/");
const legacySettings = path === "/settings" || path.startsWith("/settings/");
const signin = !web && !demo && !calendar && !mediaKit && !admin && path.startsWith("/signin");

if (path.startsWith("/test-agy")) {
  window.location.replace("/api/test-agy/ui");
} else if (legacySettings) {
  window.location.replace(`/admin${path.slice("/settings".length)}${window.location.search}${window.location.hash}`);
} else if (root && !mobileDevice) {
  window.location.replace(`/demo${window.location.search}${window.location.hash}`);
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>{mobile || (root && mobileDevice) ? <MobileHome /> : schedules ? <SchedulesPage/> : research ? <ResearchPage /> : mediaKit ? <MediaKitPage /> : calendar ? <CalendarPage /> : demo ? <DemoPage /> : web ? <WebHome /> : admin ? <SettingsPage /> : signin ? <SigninPage /> : <DemoPage />}</StrictMode>,
  );
}
