/**
 * In-app support conversations. Mirrors `shared/go/schema/support.go`.
 *
 * A conversation is addressed by the opaque userId and nothing else. The message body is free text
 * a person typed, so it is the one field here that could contain anything — which is exactly why
 * there is no other field for personal details to land in.
 */

/** Who wrote a message. `team` is Prova, deliberately not a named individual. */
export type SupportAuthor = 'user' | 'team';

/**
 * Longest message the server will store.
 *
 * Generous enough to describe a problem, small enough that the endpoint cannot be used as free
 * storage. Enforced on the server; clients should show the limit rather than truncate silently.
 *
 * Deliberately higher than MAX_CONTACT_MESSAGE_CHARS: a website enquiry arrives with the sender's
 * name and email prepended to the body, so a message at the form's own limit is still comfortably
 * under this one. Without the gap, a person who filled the box exactly to the maximum would be
 * rejected by the server for a header they never typed.
 */
export const MAX_SUPPORT_BODY_CHARS = 6000;

/** Longest message the website contact form accepts. */
export const MAX_CONTACT_MESSAGE_CHARS = 5000;

/** One entry in a conversation. */
export interface SupportMessage {
  id: number;
  author: SupportAuthor;
  body: string;
  /** ISO 8601. */
  sentAt: string;
}

/** A conversation as the operator inbox sees it. */
export interface SupportThreadRecord {
  userId: string;
  status: 'open' | 'closed';
  /** Messages the team has not answered or acknowledged. */
  unread: number;
  lastMessage?: string;
  lastAuthor?: SupportAuthor;
  /** ISO 8601. */
  lastMessageAt: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A conversation plus its messages — what a chat screen needs to open. */
export interface SupportThreadView {
  userId: string;
  status: 'open' | 'closed';
  unread: number;
  messages: SupportMessage[];
}
