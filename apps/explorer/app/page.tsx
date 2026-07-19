export default function Explorer() {
  return (<>
    <h1>Explorer</h1>
    <p style={{ color: "#bfc5cc" }}>Public device status and network activity. Private location and ownership data are never exposed. Online/offline state is server-verified.</p>
    <input placeholder="Search devices…" style={{ marginTop: 16, padding: 12, width: "100%", maxWidth: 480, background: "#101418", border: "1px solid #1e242b", borderRadius: 8, color: "#fff" }} />
  </>);
}
