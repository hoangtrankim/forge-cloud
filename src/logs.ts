// Facts for the retro, not transcripts: one JSON line per ticket change (events.jsonl) and
// per agent run (runs.jsonl), under ~/.factory/logs/<owner>/<repo>/ on the runner machine.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function logDir(repo: string, base = process.env.FACTORY_LOG_DIR ?? join(homedir(), '.factory', 'logs')): string {
  return join(base, ...repo.split('/'));
}

export class JsonlLog {
  constructor(private readonly dir: string) {}

  write(file: 'events' | 'runs', record: object): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${file}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch {
      // Logging must never stop the factory.
    }
  }
}
