import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fry Networks",
  description: "Fry Networks 3.0 — decentralized physical infrastructure, rewards, and governance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a className="logo" href="/">Fry Networks</a>
          <nav>
            <a href="/#apps">Apps</a>
            <a href="https://docs.frynetworks.com">Docs</a>
            <a href="https://dashboard.frynetworks.com">Dashboard</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>&copy; {new Date().getFullYear()} Fry Networks. All rights reserved.</p>
        </footer>
      </body>
    </html>
  );
}
