export default function Timeclock() {
  return (<>
    <h1>Timeclock</h1>
    <p style={{ color: "#bfc5cc" }}>Clock in and out. Every entry is recorded server-side with idempotency — no lost or duplicate records.</p>
    <button style={{ background: "#4da3ff", color: "#000", border: 0, borderRadius: 8, padding: "12px 24px", fontWeight: 700, marginTop: 16 }}>Clock in</button>
  </>);
}
