import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Emerald Park IT Ticket Dashboard",
  description: "Operational dashboard for Zendesk support metrics.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/emerald-park-logo.png"
  }
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <head>
        <link rel="preload" as="image" href="/splash/After-Dark-1.jpg.webp" type="image/webp" />
        <link rel="preload" as="image" href="/splash/CoasterDark.jpg" type="image/jpeg" />
      </head>
      <body>
        {children}
        <footer className="trademark-footer">Created by Ian Mugo ™</footer>
      </body>
    </html>
  );
}
