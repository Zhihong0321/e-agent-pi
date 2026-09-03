import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sales OS on Chat — AI Automation Prototype",
  description: "A conversational, AI-assisted Sales OS concept built on familiar messaging interaction patterns.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
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
