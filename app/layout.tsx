import type { Metadata, Viewport } from "next";
import "./globals.css";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vesuvius Challenge RAG Chat",
  description: "Explore the Vesuvius Challenge Discord corpus with sources and citations.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#171c18",
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
