/**
 * Fry help desk — ticket lifecycle, permission isolation, idempotent messages.
 */

export enum TicketStatus {
  OPEN = "OPEN",
  PENDING = "PENDING",
  CLOSED = "CLOSED",
}

export interface Ticket {
  id: string;
  ownerId: string;
  subject: string;
  status: TicketStatus;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  isStaff: boolean;
  createdAt: Date;
}

const LEGAL: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.OPEN]: [TicketStatus.PENDING, TicketStatus.CLOSED],
  [TicketStatus.PENDING]: [TicketStatus.OPEN, TicketStatus.CLOSED],
  [TicketStatus.CLOSED]: [TicketStatus.OPEN], // reopen
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

/** Permission isolation: visible to owner + staff only. */
export function canView(ticket: Ticket, userId: string, isStaff: boolean): boolean {
  return ticket.ownerId === userId || isStaff;
}

/** Idempotent message posting (dedupe by message id). */
export function dedupeMessages<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  return messages.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/** Transcript: ordered entries (pure). */
export function buildTranscript(ticket: Ticket, messages: TicketMessage[]): string[] {
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return [
    `# Ticket ${ticket.id}: ${ticket.subject} [${ticket.status}]`,
    ...sorted.map((m) => `[${m.createdAt.toISOString()}] ${m.isStaff ? "STAFF" : "USER"} ${m.authorId}: ${m.body}`),
  ];
}
