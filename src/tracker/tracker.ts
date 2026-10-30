// The only way the factory reads or writes tickets. GitHub Issues today; a Jira adapter
// later implements the same methods and nothing else changes.

import type { Priority, State, Ticket, TicketType } from '../lifecycle.js';

export interface NewTicket {
  title: string;
  body: string;
  type: TicketType;
  state: State;
  priority: Priority;
  risky: boolean;
  components: string[];
  blockedBy: number[];
  covers: string[];
  spec?: number;
}

export interface ListFilter {
  state?: State;
  type?: TicketType;
  includeClosed?: boolean;
}

export interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

export interface Tracker {
  setup(): Promise<void>;
  list(filter?: ListFilter): Promise<Ticket[]>;
  get(id: number): Promise<Ticket>;
  create(input: NewTicket): Promise<Ticket>;
  // Writes the whole ticket back: labels, link lines and open/closed.
  update(ticket: Ticket): Promise<Ticket>;
  comment(id: number, body: string): Promise<void>;
  comments(id: number): Promise<Comment[]>;
  close(id: number): Promise<void>;
  // Stores an evidence file and returns a link to it.
  upload(id: number, name: string, content: Buffer): Promise<string>;
}

export class NotFoundError extends Error {}
