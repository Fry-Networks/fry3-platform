export default function Claim() {
  return (<>
    <h1>Manual Claim</h1>
    <p style={{ color: "#bfc5cc" }}>Claim pending FRY 3.0 rewards. The amount is calculated by the server — never by your browser. Claims are idempotent and reconciled.</p>
    <button style={{ background: "#4da3ff", color: "#000", border: 0, borderRadius: 8, padding: "12px 24px", fontWeight: 700, marginTop: 16 }}>Claim rewards</button>
    <p style={{ color: "#6b7280", fontSize: 13, marginTop: 16 }}>Transaction status and history appear here after claiming.</p>
  </>);
}
