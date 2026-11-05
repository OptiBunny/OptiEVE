import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OptiEVE",
  description: "Private, read-only EVE overviews for wallets, training, orders and corporation operations.",
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
