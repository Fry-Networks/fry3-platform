import type { Metadata } from "next";
export const metadata: Metadata = { title: "Fry Help Desk", description: "Fry 3.0 support tickets — create, track, resolve" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{ margin: 0, background: "#000", color: "#fff", fontFamily: "Inter,system-ui,sans-serif" }}>
    <header style={{ padding: "16px 32px", borderBottom: "1px solid #1e242b" }}><strong>Fry Help Desk</strong></header>
    <main style={{ padding: 32 }}>{children}</main></body></html>);
}
