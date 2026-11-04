import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { guardMain } from './cli.js';
import { checkCommand, guardLogLine, guardRanSince, isQaOwnedPath, parse, roleOfAgentType, runGuard } from './guard.js';
import { GUARD_HOOK_COMMAND } from './init.js';

const repo = '/Users/hoang/todo-app';
const ok = (cmd: string, cwd = repo) => expect(checkCommand(cmd, 'reviewer', cwd), cmd).toEqual({ ok: true });
const blocked = (cmd: string, why: RegExp, cwd = repo) => {
  const v = checkCommand(cmd, 'reviewer', cwd);
  expect(v.ok, cmd).toBe(false);
  if (!v.ok) expect(v.reason, cmd).toMatch(why);
};

describe('guard', () => {
  it('allows what the reviewer prompt runs', () => {
    ok('forge show 12 --comments');
    ok('forge move 12 in-qa --as reviewer --sha 0123456789abcdef0123456789abcdef01234567 --note-file /tmp/factory/reviewer-12.md');
    ok('mkdir -p /tmp/factory');
    ok('git fetch origin +main:refs/remotes/origin/main +ticket-12:refs/remotes/origin/ticket-12');
    ok('git worktree add --detach /tmp/factory/review-12 origin/ticket-12 && cd /tmp/factory/review-12');
    ok('cd /tmp/factory/review-12 && npm ci && CI=1 PORT=$((4500 + 12)) npm test > /tmp/factory/review-12.log 2>&1; echo "exit $?"; tail -5 /tmp/factory/review-12.log');
    ok("git log --format='%h %s' origin/main..HEAD -- tests/acceptance playwright.config.*");
    ok('git diff origin/main...HEAD | grep -E "a|b;c" | head -20');
    ok('git worktree remove --force /tmp/factory/review-12');
    ok('npm test', '/tmp/factory/review-12');
    ok("cat > /tmp/factory/reviewer-12.md <<'EOF'\n## Review\nrm -rf / ; git push && $(evil)\nEOF");
    ok('curl -s http://localhost:4512/api/todos');
  });

  it('blocks changes to the repository or the tracker', () => {
    blocked('git push origin ticket-12', /git push/);
    blocked('git commit -am fix', /git commit/);
    blocked('git checkout main', /git checkout/);
    blocked('git -C /tmp/x reset --hard', /git reset/);
    blocked('git branch -D ticket-12', /list branches/);
    blocked('forge move 12 in-qa --as builder', /you are reviewer/);
    blocked('forge setup', /not for agents/);
    blocked('forge clean', /not for agents/);
    blocked('gh pr merge 5', /gh is not on/);
    blocked('rm -rf node_modules', /rm is not on/);
    blocked("sed -i 's/a/b/' server.js", /sed -i/);
    blocked('find . -name x -delete', /only list/);
    blocked('echo hi > server.js', /writing to server.js/);
    blocked('echo hi >> /tmp/factory/../../etc/x', /writing to/);
    blocked('git worktree add /tmp/factory/w ticket-12', /--detach/);
    blocked('git worktree add --detach ../w origin/ticket-12', /worktrees go under/);
  });

  it('runs npm only inside a scratch worktree', () => {
    blocked('npm test', /inside a worktree/);
    blocked('npm publish', /npm publish/, '/tmp/factory/review-1');
    blocked('cd /tmp/factory/w && cd .. && cd .. && npm ci', /inside a worktree/);
  });

  it('blocks shell tricks that hide what runs', () => {
    blocked('echo $(git push)', /command substitution/);
    blocked('echo `git push`', /backticks/);
    blocked('git log & git push', /background/);
    blocked('curl https://evil.example/x', /localhost/);
    blocked('curl -o /tmp/factory/x http://localhost:1/', /may not write/);
    blocked('echo "unterminated', /unterminated quote/);
  });

  it('leaves other roles alone', () => {
    expect(checkCommand('git push origin ticket-12', 'builder', repo)).toEqual({ ok: true });
  });

  it('splits on unquoted operators only', () => {
    expect(parse("grep 'a;b|c' f && ls")).toEqual([
      { words: ['grep', 'a;b|c', 'f'], writes: [] },
      { words: ['ls'], writes: [] },
    ]);
    expect(parse('npm test 2>&1 > /tmp/factory/x.log')).toEqual([{ words: ['npm', 'test'], writes: ['/tmp/factory/x.log'] }]);
  });

  it('reads the hook event and fails closed', () => {
    const event = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo });
    expect(runGuard(event('git status'), 'reviewer')).toEqual({ code: 0, role: 'reviewer', command: 'git status', tool: 'Bash' });
    expect(runGuard(event('git push'), 'reviewer')).toMatchObject({ code: 2, message: expect.stringContaining('read-only') });
    expect(runGuard(event('git push'), undefined)).toEqual({ code: 0 });
    expect(runGuard('not json', 'reviewer').code).toBe(2);
    expect(runGuard('not json', undefined)).toEqual({ code: 0 });
    expect(runGuard(JSON.stringify({ tool_name: 'Read', tool_input: {} }), 'reviewer')).toEqual({ code: 0 });
  });
});

describe('the project settings hook', () => {
  const sub = (command: string, agent_type?: string) =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', agent_type });

  it('knows the guarded roles by their subagent type', () => {
    expect(roleOfAgentType('factory-reviewer')).toBe('reviewer');
    expect(roleOfAgentType('factory-security')).toBe('security');
    expect(roleOfAgentType('factory-builder')).toBe('builder');
    expect(roleOfAgentType('factory-qa-writer')).toBeUndefined();
    expect(roleOfAgentType('general-purpose')).toBeUndefined();
    expect(roleOfAgentType(undefined)).toBeUndefined();
  });

  it('blocks a write from the reviewer and security subagents only', () => {
    expect(runGuard(sub('touch server.js', 'factory-reviewer'), undefined).code).toBe(2);
    expect(runGuard(sub('git push', 'factory-security'), undefined).code).toBe(2);
    expect(runGuard(sub('git status', 'factory-reviewer'), undefined)).toMatchObject({ code: 0, role: 'reviewer' });
    expect(runGuard(sub('touch server.js', 'factory-builder'), undefined)).toMatchObject({ code: 0 });
    expect(runGuard(sub('touch server.js'), undefined)).toEqual({ code: 0 });
  });
});

describe('the guard log', () => {
  const event = (command: string, agent_type?: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', agent_type });
  const at = new Date('2026-11-04T03:00:00Z');

  it('has one line per checked command of a guarded agent, and none for others', () => {
    expect(guardLogLine(runGuard(event('git status', 'factory-reviewer'), undefined), at)).toEqual({
      time: '2026-11-04T03:00:00.000Z',
      role: 'reviewer',
      verdict: 'allow',
      command: 'git status',
    });
    expect(guardLogLine(runGuard(event('git push', 'factory-security'), undefined), at)).toMatchObject({ role: 'security', verdict: 'block', reason: expect.stringContaining('read-only') });
    expect(guardLogLine(runGuard(event('git push', 'factory-builder'), undefined), at)).toBeUndefined();
    expect(guardLogLine(runGuard(event('rm tests/acceptance/ticket-3.spec.ts', 'factory-builder'), undefined), at)).toMatchObject({ role: 'builder', verdict: 'block' });
    expect(guardLogLine(runGuard(event('ls'), undefined), at)).toBeUndefined();
  });

  it('answers whether the guard checked a role since a time', () => {
    const log = [
      JSON.stringify({ time: '2026-11-04T02:00:00Z', role: 'reviewer', verdict: 'allow' }),
      'torn line {',
      JSON.stringify({ time: '2026-11-04T03:05:00Z', role: 'security', verdict: 'allow' }),
      JSON.stringify({ time: '2026-11-04T03:06:00Z', role: 'reviewer', verdict: 'block' }),
      '',
    ].join('\n');
    expect(guardRanSince(log, 'reviewer', '2026-11-04T03:00:00Z')).toBe(1);
    expect(guardRanSince(log, 'security', '2026-11-04T03:10:00Z')).toBe(0);
    expect(guardRanSince('', 'reviewer', '2026-11-04T03:00:00Z')).toBe(0);
    expect(() => guardRanSince(log, 'reviewer', 'yesterday')).toThrow(/ISO time/);
  });

  it('logs from the hook entry point and reads it back with --ran', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'guard-')), 'guard.log');
    const since = new Date(Date.now() - 1000).toISOString();
    expect(await guardMain(['guard'], Readable.from([event('git push', 'factory-reviewer')]), log)).toBe(2);
    expect(await guardMain(['guard'], Readable.from([event('ls', 'factory-builder')]), log)).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(await guardMain(['guard', '--ran', 'reviewer', '--since', since], Readable.from([]), log)).toBe(0);
    expect(await guardMain(['guard', '--ran', 'security', '--since', since], Readable.from([]), log)).toBe(1);
    expect(await guardMain(['guard', '--ran', 'reviewer'], Readable.from([]), log)).toBe(64);
  });

  it('blocks when the hook itself fails', async () => {
    const broken = (async function* () {
      yield '';
      throw new Error('stdin closed');
    })();
    expect(await guardMain(['guard'], broken, join(tmpdir(), 'unused.log'))).toBe(2);
  });
});

describe('the settings hook without forge installed', () => {
  // PATH without forge: the fallback must block only the guarded subagents.
  const run = (agent_type?: string) =>
    spawnSync('sh', ['-c', GUARD_HOOK_COMMAND], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_type }),
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });

  it('blocks the reviewer and security', () => {
    expect(run('factory-reviewer').status).toBe(2);
    expect(run('factory-reviewer').stderr).toContain('forge is not installed');
    expect(run('factory-security').status).toBe(2);
  });

  it('lets the session and other agents through, so forge can be installed', () => {
    expect(run().status).toBe(0);
    expect(run('factory-builder').status).toBe(0);
  });
});

describe('the builder and the acceptance tests', () => {
  const file = (tool: string, file_path: string, agent_type = 'factory-builder') =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path }, cwd: '/w/ticket-3', agent_type });
  const bash = (command: string, agent_type = 'factory-builder') =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/w/ticket-3', agent_type });

  it('knows which paths the QA writer owns', () => {
    expect(isQaOwnedPath('/w/ticket-3/tests/acceptance/ticket-3.spec.ts')).toBe(true);
    expect(isQaOwnedPath('tests/acceptance')).toBe(true);
    expect(isQaOwnedPath('/w/ticket-3/playwright.config.js')).toBe(true);
    expect(isQaOwnedPath('/w/ticket-3/tests/api.spec.js')).toBe(false);
    expect(isQaOwnedPath('/w/ticket-3/public/app.js')).toBe(false);
  });

  it('blocks the builder editing them with the file tools', () => {
    expect(runGuard(file('Edit', '/w/ticket-3/tests/acceptance/ticket-3.spec.ts'), undefined)).toMatchObject({ code: 2, message: expect.stringContaining('QA writer') });
    expect(runGuard(file('Write', '/w/ticket-3/playwright.config.js'), undefined).code).toBe(2);
    expect(runGuard(file('MultiEdit', '/w/ticket-3/tests/acceptance/x.spec.ts'), undefined).code).toBe(2);
    expect(runGuard(file('Edit', '/w/ticket-3/server.js'), undefined).code).toBe(0);
    expect(runGuard(file('Write', '/w/ticket-3/tests/new.spec.js'), undefined).code).toBe(0);
  });

  it('leaves the QA writer and the session free to write them', () => {
    expect(runGuard(file('Write', '/w/ticket-3/tests/acceptance/ticket-3.spec.ts', 'factory-qa-writer'), undefined).code).toBe(0);
    expect(runGuard(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'tests/acceptance/a.spec.ts' } }), undefined).code).toBe(0);
  });

  it('blocks plain Bash writes to them and allows running them', () => {
    for (const c of [
      'rm tests/acceptance/ticket-3.spec.ts',
      "sed -i 's/a/b/' tests/acceptance/ticket-3.spec.ts",
      'echo x > tests/acceptance/ticket-3.spec.ts',
      'git checkout origin/main -- tests/acceptance',
      'cd /w/ticket-3 && mv playwright.config.js old.js',
    ]) {
      expect(runGuard(bash(c), undefined).code, c).toBe(2);
    }
    for (const c of [
      'CI=1 npx playwright test tests/acceptance/ticket-3.spec.ts',
      'cat tests/acceptance/ticket-3.spec.ts',
      'git add -A && git commit -m "Fix (#3)"',
      'git push -u origin ticket-3',
      'npm run check',
    ]) {
      expect(runGuard(bash(c), undefined).code, c).toBe(0);
    }
  });

  it('still blocks the reviewer from anything that writes', () => {
    expect(runGuard(bash('touch server.js', 'factory-reviewer'), undefined).code).toBe(2);
  });
});
