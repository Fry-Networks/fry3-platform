export default function Overview() {
  return (<>
    <h1>Overview</h1>
    <p style={{ color: "#bfc5cc" }}>Devices, integrations, and reward eligibility. Server-verified. Offline devices earn zero.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 16, marginTop: 24 }}>
      {["Devices", "Integrations", "Pending Rewards", "Claim History"].map((t) => (
        <div key={t} style={{ background: "#101418", border: "1px solid #1e242b", borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t}</h3><p style={{ color: "#bfc5cc" }}>—</p>
        </div>
      ))}
    </div>
  </>);
}
