import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/ci/upstream_lines.sh over a scratch repo (#1234): "upstream" is the fork point and its
// ancestors, whoever wrote the later commits.
const ROOT = join(__dirname, '..');
const OWNER = 'kashhq@users.noreply.github.com';
const LONG_LINE =
  'export const inheritedSentenceLongEnoughToMatch = compute(first);';
const BOT_LINE = 'const botWrittenLineLongEnoughToBeInTheCorpus = run(1, 2);';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(email: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(repo, name), text);
  }
  git('add', '.');
  execFileSync('git', ['commit', '-q', '-m', 'c'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'n',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'n',
      GIT_COMMITTER_EMAIL: email,
    },
  });
  return git('rev-parse', 'HEAD');
}

function run(base: string) {
  writeFileSync(join(repo, 'scripts/ci/upstream_base'), `${base}\n`);
  const result = spawnSync('bash', ['scripts/ci/upstream_lines.sh'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'upstream-lines-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'scripts/ci'), { recursive: true });
  for (const file of ['upstream-rewraps.ts', 'upstream-match.ts']) {
    copyFileSync(join(ROOT, 'scripts', file), join(repo, 'scripts', file));
  }
  copyFileSync(
    join(ROOT, 'scripts/ci/upstream_lines.sh'),
    join(repo, 'scripts/ci/upstream_lines.sh'),
  );
  writeFileSync(
    join(repo, 'scripts/ci/upstream_exempt.txt'),
    `inherited.txt\texempt word\ninherited.txt\t${LONG_LINE}\n`,
  );
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  symlinkSync(join(ROOT, 'tsconfig.json'), join(repo, 'tsconfig.json'));
  // The harness files stay untracked, so blame never sees them.
  writeFileSync(
    join(repo, '.git', 'info', 'exclude'),
    'scripts\nnode_modules\ntsconfig.json\n',
  );
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('upstream_lines.sh', () => {
  it('reports a bot commit as post-fork, and counts only a copy of inherited text', () => {
    const base = commit('up@example.com', {
      'inherited.txt': `exempt word\n${LONG_LINE}\n`,
    });
    commit('bot@example.com', { 'bot.txt': `${BOT_LINE}\n` });
    commit(OWNER, { 'mine.txt': `${BOT_LINE}\n` });
    const clean = run(base);
    expect(clean.out).toContain('UPSTREAM 0 substantive');
    // -C blames the owner's copy of a bot line to the bot's commit: post-fork either way.
    expect(clean.out).toContain('2 post-fork other-author line(s)');
    expect(clean.out).toMatch(/^post-fork\t1\tbot\.txt$/m);
    expect(clean.status).toBe(0);

    commit(OWNER, { 'copy.txt': `  ${LONG_LINE.slice(0, -1)},\n` });
    const dirty = run(base);
    expect(dirty.out).toMatch(/^rewrapped\tcopy\.txt:1\t/m);
    expect(dirty.status).toBe(1);
  });

  it('counts a line from a fork-point ancestor whatever its author', () => {
    commit('up@example.com', { 'a.txt': 'first inherited commit line here\n' });
    const base = commit('bot@example.com', {
      'b.txt': 'second inherited commit line here\n',
    });
    commit(OWNER, { 'mine.txt': 'a line the owner wrote today\n' });
    const result = run(base);
    expect(result.out).toMatch(/^1\t1\ta\.txt$/m);
    expect(result.out).toMatch(/^1\t1\tb\.txt$/m);
    expect(result.status).toBe(1);
  });

  it('refuses a clone that lacks the fork point', () => {
    commit(OWNER, { 'mine.txt': 'a line the owner wrote today\n' });
    const result = run('0'.repeat(40));
    expect(result.status).toBe(2);
    expect(result.err).toContain('is not in this clone');
  });
});
