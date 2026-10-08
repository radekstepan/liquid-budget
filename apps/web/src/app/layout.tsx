import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Liquid — Budget",
  description: "A zero-based envelope budgeting app. A YNAB4 alternative.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
