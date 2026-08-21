import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chatly — Mobile Chat UI Template",
  description: "A mobile-first messaging interface template.",
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
