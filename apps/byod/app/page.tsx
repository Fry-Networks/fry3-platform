"use client";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_FRY3_API_BASE ?? "";

type DeviceInfo = { id: string; label: string | null; lastHeartbeatAt: string | null; status: string };
type License = { status: string; activatedAt: string | null; expiresAt: string | null; createdAt: string; device: DeviceInfo | null };

const card: React.CSSProperties = { background: "#0d1117", border: "1px solid #1e242b", borderRadius: 12, padding: 24, maxWidth: 560 };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8, border: "1px solid #2a323b", background: "#04070a", color: "#fff", fontFamily: "inherit", fontSize: 14 };
const buttonStyle: React.CSSProperties = { padding: "10px 20px", borderRadius: 8, border: "none", background: "#f5c518", color: "#000", fontWeight: 600, cursor: "pointer", fontSize: 14 };
const label: React.CSSProperties = { color: "#8b949e", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 };

function StatusChip({ value }: { value: string }) {
  const colors: Record<string, string> = { ACTIVE: "#2ea043", ONLINE: "#2ea043", OFFLINE: "#8b949e", REVOKED: "#f85149", EXPIRED: "#f85149", BANNED: "#f85149", DISABLED: "#8b949e" };
  return (
    <span style={{ background: (colors[value] ?? "#8b949e") + "22", color: colors[value] ?? "#8b949e", border: `1px solid ${colors[value] ?? "#8b949e"}`, borderRadius: 999, padding: "2px 12px", fontSize: 12, fontWeight: 600 }}>
      {value}
    </span>
  );
}

function fmt(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleString();
}

export default function Byod() {
  const [key, setKey] = useState("");
  const [license, setLicense] = useState<License | null>(null);
  const [deviceRef, setDeviceRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (k?: string) => {
    const licenseKey = (k ?? key).trim();
    setError(null); setNotice(null);
    if (licenseKey.length < 8) { setError("Enter your full license key."); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/byod/lookup`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseKey }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setLicense(null); setError(j.reason === "license_not_found" ? "License not found. Check the key and try again." : `Lookup failed (${j.reason ?? r.status}).`); return; }
      setLicense(j.license as License);
      setDeviceRef(""); // a fresh lookup targets a (possibly different) license — never carry a stale device ref into its activate form
    } catch {
      setLicense(null); setError("Could not reach the Fry API. Try again shortly.");
    } finally { setBusy(false); }
  };

  const activate = async () => {
    setError(null); setNotice(null);
    if (!deviceRef.trim()) { setError("Enter the device ID (or miner key) to activate."); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/byod/activate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseKey: key.trim(), device: deviceRef.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msgs: Record<string, string> = {
          cross_account_denied: "That device belongs to a different account. Cross-account activation is not allowed.",
          license_device_bound: "This license is already bound to another device.",
          device_already_licensed: "That device already has a license.",
          license_not_active: "This license is not active.",
          license_expired: "This license has expired.",
          device_not_found: "Device not found. Check the device ID / miner key.",
          device_banned: "That device is banned and cannot be licensed.",
        };
        setError(msgs[j.reason] ?? `Activation failed (${j.reason ?? r.status}).`);
        return;
      }
      setDeviceRef("");
      await lookup();
      // set AFTER the refresh lookup — lookup() clears notices on entry, which used to wipe this before paint
      setNotice(j.idempotent ? "License was already active on this device." : "License activated on your device.");
    } catch {
      setError("Could not reach the Fry API. Try again shortly.");
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1 style={{ marginTop: 0 }}>BYOD Licensing</h1>
      <p style={{ color: "#bfc5cc", maxWidth: 560 }}>
        Bring your own device. Existing licenses, ownership, and entitlements are preserved.
        Cross-account access is prevented.
      </p>

      <div style={card}>
        <div style={label}>License key</div>
        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <input
            style={inputStyle} value={key} placeholder="Paste your BYOD license key"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
            autoComplete="off" spellCheck={false} data-testid="license-key-input"
          />
          <button style={{ ...buttonStyle, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => lookup()} data-testid="lookup-button">
            {busy ? "…" : "Look up"}
          </button>
        </div>
        {error && <p style={{ color: "#f85149", marginBottom: 0 }} data-testid="error">{error}</p>}
        {notice && <p style={{ color: "#2ea043", marginBottom: 0 }} data-testid="notice">{notice}</p>}
      </div>

      {license && (
        <div style={{ ...card, marginTop: 16 }} data-testid="license-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={label}>License</div>
            <StatusChip value={license.status} />
          </div>
          <table style={{ marginTop: 12, borderSpacing: 0, fontSize: 14 }}>
            <tbody>
              <tr><td style={{ ...label, paddingRight: 16, paddingBottom: 6 }}>Created</td><td>{fmt(license.createdAt)}</td></tr>
              <tr><td style={{ ...label, paddingRight: 16, paddingBottom: 6 }}>Activated</td><td>{fmt(license.activatedAt)}</td></tr>
              <tr><td style={{ ...label, paddingRight: 16 }}>Expires</td><td>{license.expiresAt ? fmt(license.expiresAt) : "Never"}</td></tr>
            </tbody>
          </table>

          <hr style={{ border: "none", borderTop: "1px solid #1e242b", margin: "16px 0" }} />

          {license.device ? (
            <div data-testid="device-info">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={label}>Bound device</div>
                <StatusChip value={license.device.status} />
              </div>
              <table style={{ marginTop: 12, borderSpacing: 0, fontSize: 14 }}>
                <tbody>
                  <tr><td style={{ ...label, paddingRight: 16, paddingBottom: 6 }}>Device</td><td style={{ fontFamily: "monospace" }}>{license.device.label ?? license.device.id}</td></tr>
                  <tr><td style={{ ...label, paddingRight: 16 }}>Last heartbeat</td><td>{fmt(license.device.lastHeartbeatAt)}</td></tr>
                </tbody>
              </table>
            </div>
          ) : license.status === "ACTIVE" ? (
            <div data-testid="activate-form">
              <div style={label}>Activate on your device</div>
              <p style={{ color: "#8b949e", fontSize: 13 }}>Enter the device ID or miner key shown in your Fry Edge Miner. The device must belong to the same account as this license.</p>
              <div style={{ display: "flex", gap: 12 }}>
                <input
                  style={inputStyle} value={deviceRef} placeholder="Device ID or miner key"
                  onChange={(e) => setDeviceRef(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") activate(); }}
                  autoComplete="off" spellCheck={false} data-testid="device-input"
                />
                <button style={{ ...buttonStyle, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={activate} data-testid="activate-button">
                  {busy ? "…" : "Activate"}
                </button>
              </div>
            </div>
          ) : (
            <p style={{ color: "#8b949e", marginBottom: 0 }}>This license is not active and cannot be bound to a device.</p>
          )}
        </div>
      )}
    </>
  );
}
