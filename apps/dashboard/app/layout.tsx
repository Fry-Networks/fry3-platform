import type { Metadata } from "next";
export const metadata: Metadata = { title: "Fry Dashboard", description: "Fry 3.0 — devices, rewards, claims" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{ margin: 0, background: "#000", color: "#fff", fontFamily: "Inter,system-ui,sans-serif" }}>
    <header style={{ padding: "16px 32px", borderBottom: "1px solid #1e242b", display: "flex", justifyContent: "space-between" }}>
      <strong>Fry Dashboard</strong>
      <nav><a href="/" style={{ color: "#bfc5cc", marginRight: 16 }}>Overview</a><a href="/claim" style={{ color: "#bfc5cc" }}>Claim</a></nav>
    </header>
    <main style={{ padding: 32 }}>{children}</main>
  </body></html>);
}
