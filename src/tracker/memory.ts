// In-memory tracker for tests and dry runs.

import type { Ticket } from '../lifecycle.js';
import { NotFoundError, type Comment, type ListFilter, type NewTicket, type Tracker } from './tracker.js';

export class MemoryTracker implements Tracker {
  private tickets = new Map<number, Ticket>();
  private nextId = 1;
  readonly posted = new Map<number, string[]>();
  readonly uploads = new Map<string, Buffer>();

  async setup(): Promise<void> {}

  async list(filter: ListFilter = {}): Promise<Ticket[]> {
    return [...this.tickets.values()]
      .filter((t) => filter.includeClosed || !t.closed)
      .filter((t) => !filter.state || t.state === filter.state)
      .filter((t) => !filter.type || t.type === filter.type)
      .map(clone);
  }

  async get(id: number): Promise<Ticket> {
    const t = this.tickets.get(id);
    if (!t) throw new NotFoundError(`#${id} not found`);
    return clone(t);
  }

  async create(input: NewTicket): Promise<Ticket> {
    const t: Ticket = {
      ...input,
      id: this.nextId++,
      round: 0,
      testsReady: false,
      gates: {},
      closed: false,
    };
    this.tickets.set(t.id, clone(t));
    return clone(t);
  }

  async update(ticket: Ticket): Promise<Ticket> {
    if (!this.tickets.has(ticket.id)) throw new NotFoundError(`#${ticket.id} not found`);
    this.tickets.set(ticket.id, clone(ticket));
    return clone(ticket);
  }

  async comment(id: number, body: string): Promise<void> {
    await this.get(id);
    this.posted.set(id, [...(this.posted.get(id) ?? []), body]);
  }

  async comments(id: number): Promise<Comment[]> {
    await this.get(id);
    return (this.posted.get(id) ?? []).map((body, i) => ({ author: 'factory', body, createdAt: new Date(i * 1000).toISOString() }));
  }

  async close(id: number): Promise<void> {
    const t = await this.get(id);
    this.tickets.set(id, { ...t, closed: true });
  }

  async upload(id: number, name: string, content: Buffer): Promise<string> {
    const key = `${id}/${name}`;
    this.uploads.set(key, content);
    return `memory://${key}`;
  }
}

const clone = (t: Ticket): Ticket => structuredClone(t);
