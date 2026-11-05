// Test doubles shared by the test files. Not part of the build (see tsconfig.json).

import type { ChangedFile, LabelEvent } from '../risk.js';

// The risk and label half of a fake CodeHost. Arrow-function fields, so `{ ...new RiskFakes() }`
// works for plain-object hosts as well as `extends RiskFakes` for classes.
// By default the repo's risk.yml makes every file low, and the PR changes one small file.
export class RiskFakes {
  changed: ChangedFile[] = [{ path: 'src/app.js', additions: 10, deletions: 2 }];
  riskYml: string | undefined = 'default: low\n';
  prLabels = new Map<number, string[]>();
  events: LabelEvent[] = [];
  files = async (_n: number): Promise<ChangedFile[]> => this.changed;
  readFile = async (_path: string, _ref: string): Promise<string | undefined> => this.riskYml;
  labels = async (n: number): Promise<string[]> => [...(this.prLabels.get(n) ?? [])];
  labelEvents = async (_n: number): Promise<LabelEvent[]> => this.events;
  addLabel = async (n: number, label: string): Promise<void> => {
    this.prLabels.set(n, [...(this.prLabels.get(n) ?? []).filter((l) => l !== label), label]);
  };
  removeLabel = async (n: number, label: string): Promise<void> => {
    this.prLabels.set(n, (this.prLabels.get(n) ?? []).filter((l) => l !== label));
  };
}
