import { describe, expect, it } from 'vitest';
import { checkCommand, parse, runGuard } from './guard.js';

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
    expect(runGuard(event('git status'), 'reviewer')).toEqual({ code: 0 });
    expect(runGuard(event('git push'), 'reviewer')).toMatchObject({ code: 2, message: expect.stringContaining('read-only') });
    expect(runGuard(event('git push'), undefined)).toEqual({ code: 0 });
    expect(runGuard('not json', 'reviewer').code).toBe(2);
    expect(runGuard(JSON.stringify({ tool_name: 'Read', tool_input: {} }), 'reviewer')).toEqual({ code: 0 });
  });
});
