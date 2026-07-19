const API = process.env.NEXT_PUBLIC_FRY3_API ?? "http://127.0.0.1:3000";
export async function getHealth() { const r = await fetch(`${API}/health`, { cache: "no-store" }); return r.json(); }
export async function getDeviceStatus(id: string) { const r = await fetch(`${API}/api/v1/devices/${id}/status`, { cache: "no-store" }); return r.json(); }
export async function previewReward(body: unknown) {
  const r = await fetch(`${API}/api/v1/rewards/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return r.json();
}
export async function createClaim(body: unknown) {
  const r = await fetch(`${API}/api/v1/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return r.json();
}
