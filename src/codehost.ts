// Pull requests and CI live on the code host, which stays GitHub even if tickets move to Jira.
// Agents use these through the CLI because `gh pr ...` needs GraphQL, which some networks block.

import { ghCli, type GhApi } from './tracker/github.js';

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  // The base branch has commits the PR does not, and the host wants it up to date to merge.
  behind?: boolean;
}

export interface Check {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  // The Actions run the check belongs to, when there is one (for `gh run view/download`).
  runId?: number;
}

export interface CodeHost {
  findPr(branch: string): Promise<PullRequest | undefined>;
  openPr(branch: string, base: string, title: string, body: string): Promise<PullRequest>;
  getPr(number: number): Promise<PullRequest>;
  diff(number: number): Promise<string>;
  checks(number: number): Promise<Check[]>;
  // A commit status. Statuses belong to one commit, so a new push starts without them.
  setStatus(sha: string, context: string, state: 'success' | 'failure' | 'pending', description: string): Promise<void>;
  // Merges only if the PR head is still `sha`. Branch protection (required checks, up to date)
  // is enforced by the host, so a merge it refuses throws.
  merge(number: number, sha: string, method: MergeMethod): Promise<void>;
  // Merges the base branch into the PR, only if its head is still `sha`. The new head is a
  // new commit, so it needs its own review and checks.
  updateBranch(number: number, sha: string): Promise<void>;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

interface GhPull {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  state: 'open' | 'closed';
  merged_at: string | null;
  mergeable_state?: string;
}

const toPr = (p: GhPull): PullRequest => ({
  number: p.number,
  url: p.html_url,
  head: p.head.ref,
  headSha: p.head.sha,
  state: p.state,
  merged: !!p.merged_at,
  behind: p.mergeable_state === 'behind',
});

export class GitHubCodeHost implements CodeHost {
  constructor(
    private readonly repo: string,
    private readonly gh: GhApi = ghCli,
  ) {}

  private path(p: string) {
    return `repos/${this.repo}/${p}`;
  }

  async findPr(branch: string): Promise<PullRequest | undefined> {
    const owner = this.repo.split('/')[0];
    const pulls = (await this.gh({ path: this.path(`pulls?state=all&head=${owner}:${branch}&per_page=10`) })) as GhPull[];
    const open = pulls.find((p) => p.state === 'open') ?? pulls[0];
    return open && toPr(open);
  }

  async openPr(branch: string, base: string, title: string, body: string): Promise<PullRequest> {
    return toPr((await this.gh({ method: 'POST', path: this.path('pulls'), body: { head: branch, base, title, body } })) as GhPull);
  }

  async getPr(number: number): Promise<PullRequest> {
    return toPr((await this.gh({ path: this.path(`pulls/${number}`) })) as GhPull);
  }

  async diff(number: number): Promise<string> {
    return (await this.gh({ path: this.path(`pulls/${number}`), accept: 'application/vnd.github.diff' })) as string;
  }

  async checks(number: number): Promise<Check[]> {
    const pr = await this.getPr(number);
    const res = (await this.gh({ path: this.path(`commits/${pr.headSha}/check-runs?per_page=100`) })) as {
      check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }>;
    };
    return res.check_runs.map((c) => {
      const run = /\/actions\/runs\/(\d+)/.exec(c.html_url)?.[1];
      return { name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, ...(run ? { runId: Number(run) } : {}) };
    });
  }

  async setStatus(sha: string, context: string, state: 'success' | 'failure' | 'pending', description: string): Promise<void> {
    await this.gh({ method: 'POST', path: this.path(`statuses/${sha}`), body: { state, context, description } });
  }

  async merge(number: number, sha: string, method: MergeMethod): Promise<void> {
    await this.gh({ method: 'PUT', path: this.path(`pulls/${number}/merge`), body: { sha, merge_method: method } });
  }

  async updateBranch(number: number, sha: string): Promise<void> {
    await this.gh({ method: 'PUT', path: this.path(`pulls/${number}/update-branch`), body: { expected_head_sha: sha } });
  }
}
