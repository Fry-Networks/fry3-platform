import { APP_LINKS } from "@/lib/apps";

export default function Home() {
  return (
    <>
      <section className="hero">
        <h1>Decentralized infrastructure, real rewards.</h1>
        <p>
          Fry Networks 3.0 — run devices, activate integrations, and earn FRY 3.0.
          Manage everything from your dashboard.
        </p>
      </section>
      <h2 className="section-title" id="apps">Applications</h2>
      <section className="grid">
        {APP_LINKS.map((a) => (
          <a key={a.name} className="card" href={a.url} target="_blank" rel="noopener noreferrer">
            <h3>{a.name}</h3>
            <p>{a.desc}</p>
          </a>
        ))}
      </section>
    </>
  );
}
