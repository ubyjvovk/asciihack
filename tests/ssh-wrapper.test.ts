/**
 * Tests for bin/asciihack-lib.sh — the pure, sourceable helpers behind the ssh
 * login wrapper (docs/ssh.md). Exercised via `bash -c 'source ...; expr'` so
 * nothing needs sshd.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'bin', 'asciihack-lib.sh');

/** Evaluate a bash expression after sourcing the lib; trimmed stdout. */
function libExpr(expr: string): string {
  return execFileSync('bash', ['-c', `source "${lib}"; ${expr}`], { encoding: 'utf8' }).trim();
}

/** True iff asciihack_valid_name accepts the given name. */
function valid(name: string): boolean {
  return libExpr(`asciihack_valid_name '${name}' && echo yes || echo no`) === 'yes';
}

describe('ssh wrapper lib', () => {
  it('accepts valid names (mia, Mia_2)', () => {
    expect(valid('mia')).toBe(true);
    expect(valid('Mia_2')).toBe(true);
  });

  it('rejects empty, path, over-long, and spaced names', () => {
    expect(valid('')).toBe(false);
    expect(valid('../x')).toBe(false);
    expect(valid('aaaaaaaaaaaaaaaaaaaaa')).toBe(false); // 21 chars
    expect(valid('has space')).toBe(false);
  });

  it('derives the playground path from ASCIIHACK_HOME and the default home', () => {
    expect(libExpr('ASCIIHACK_HOME=/tmp/x asciihack_player_dir mia')).toBe('/tmp/x/players/mia');
    expect(libExpr('asciihack_home')).toBe(`${process.env.HOME}/.asciihack`);
    expect(libExpr('asciihack_player_dir Mia_2')).toBe(`${process.env.HOME}/.asciihack/players/Mia_2`);
  });
});
