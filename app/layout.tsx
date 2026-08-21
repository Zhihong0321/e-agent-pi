import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sales OS on Chat — AI Automation Prototype",
  description: "A conversational, AI-assisted Sales OS concept built on familiar messaging interaction patterns.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
