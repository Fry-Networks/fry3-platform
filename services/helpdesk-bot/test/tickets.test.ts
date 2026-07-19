import { describe, it, expect } from "vitest";
import { canTransition, canView, dedupeMessages, buildTranscript, TicketStatus, Ticket } from "../src/tickets";

const ticket: Ticket = { id: "t1", ownerId: "u1", subject: "help", status: TicketStatus.OPEN };

describe("ticket state machine", () => {
  it("legal transitions", () => {
    expect(canTransition(TicketStatus.OPEN, TicketStatus.PENDING)).toBe(true);
    expect(canTransition(TicketStatus.PENDING, TicketStatus.CLOSED)).toBe(true);
    expect(canTransition(TicketStatus.CLOSED, TicketStatus.OPEN)).toBe(true);
  });
  it("illegal rejected", () => {
    expect(canTransition(TicketStatus.OPEN, TicketStatus.OPEN)).toBe(false);
  });
});

describe("permission isolation", () => {
  it("owner can view", () => expect(canView(ticket, "u1", false)).toBe(true));
  it("staff can view", () => expect(canView(ticket, "u2", true)).toBe(true));
  it("non-owner non-staff CANNOT view", () => expect(canView(ticket, "u2", false)).toBe(false));
});

describe("idempotent messages", () => {
  it("dedupes by id", () => {
    expect(dedupeMessages([{ id: "m1" }, { id: "m1" }] as any)).toHaveLength(1);
  });
});

describe("transcript", () => {
  it("ordered entries", () => {
    const msgs = [
      { id: "m2", ticketId: "t1", authorId: "s1", body: "reply", isStaff: true, createdAt: new Date("2026-01-02") },
      { id: "m1", ticketId: "t1", authorId: "u1", body: "hi", isStaff: false, createdAt: new Date("2026-01-01") },
    ];
    const t = buildTranscript(ticket, msgs);
    expect(t[0]).toContain("Ticket t1");
    expect(t[1]).toContain("hi");
    expect(t[2]).toContain("reply");
  });
});
