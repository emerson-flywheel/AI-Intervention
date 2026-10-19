import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCode, checkLoginUrl } from '../rootfs/opt/addon-agent/linkcheck.mjs';
import { GOOD_LINK } from './helpers.mjs';

const swap = (from, to) => {
  assert.ok(GOOD_LINK.includes(from), `fixture has ${from}`);
  return GOOD_LINK.replace(from, to);
};

test('a real-shaped sign-in link passes (claude.com and claude.ai, every allowed scope)', () => {
  assert.equal(checkLoginUrl(GOOD_LINK), true);
  assert.equal(checkLoginUrl(swap('https://claude.com/cai/', 'https://claude.ai/')), true);
  assert.equal(checkLoginUrl(swap('+user%3Afile_upload', '+user%3Afile_upload+user%3Aplugins')), true);
});

test('another client_id fails', () => {
  assert.equal(checkLoginUrl(swap('9d1c250a-e61b-44d9-88ed-5944d1962f5e', '9d1c250a-e61b-44d9-88ed-5944d1962f5f')), false);
});

test('another redirect_uri fails', () => {
  assert.equal(checkLoginUrl(swap('platform.claude.com%2Foauth', 'evil.example%2Foauth')), false);
  assert.equal(checkLoginUrl(swap('callback&', 'callback%2Fx&')), false);
});

test('an extra (unknown) scope fails: a newer Claude Code asking for more is refused', () => {
  assert.equal(checkLoginUrl(swap('+user%3Afile_upload', '+user%3Afile_upload+user%3Aadmin')), false);
  assert.equal(checkLoginUrl(swap('scope=org', 'scope=+org')), false);
});

test('a doubled param fails, for each of client_id, redirect_uri, response_type and scope', () => {
  for (const p of [
    '&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    '&response_type=code',
    '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
    '&scope=user%3Aprofile',
  ]) {
    assert.equal(checkLoginUrl(GOOD_LINK + p), false, p);
  }
});

test('a missing param, a wrong response_type, or a wrong host or scheme fails', () => {
  assert.equal(checkLoginUrl(swap('&response_type=code', '')), false);
  assert.equal(checkLoginUrl(swap('response_type=code', 'response_type=token')), false);
  assert.equal(checkLoginUrl(swap('https://claude.com/', 'http://claude.com/')), false);
  assert.equal(checkLoginUrl(swap('https://claude.com/', 'https://claude.com.evil.example/')), false);
  assert.equal(checkLoginUrl(swap('https://claude.com/', 'https://evil.example/claude.com/')), false);
  assert.equal(checkLoginUrl(swap('https://claude.com/', 'https://x@claude.com/')), false);
  assert.equal(checkLoginUrl(swap('https://claude.com/', 'https://claude.com:8443/')), false);
  assert.equal(checkLoginUrl(swap('cai/oauth/authorize', 'cai/oauth/token')), false);
  assert.equal(checkLoginUrl(`${GOOD_LINK} `), false);
  assert.equal(checkLoginUrl(`${GOOD_LINK}"`), false);
  assert.equal(checkLoginUrl(`${GOOD_LINK}<x>`), false);
  assert.equal(checkLoginUrl(`javascript:alert(1)//${GOOD_LINK}`), false);
  assert.equal(checkLoginUrl(null), false);
});

test('the code check: 8 to 600 of [A-Za-z0-9_.~#-]', () => {
  assert.equal(checkCode('abcd1234'), true);
  assert.equal(checkCode('Ab_.~#-9'.repeat(75)), true);
  assert.equal(checkCode('abc1234'), false);
  assert.equal(checkCode('a'.repeat(601)), false);
  assert.equal(checkCode('abcd 1234'), false);
  assert.equal(checkCode('abcd1234\n'), false);
  assert.equal(checkCode('abcd1234;rm'), false);
  assert.equal(checkCode('abcd$(id)'), false);
  assert.equal(checkCode(undefined), false);
});

test('only the known query keys: any other key fails, even a harmless-looking one', () => {
  for (const extra of ['&login_hint=a%40b.c', '&prompt=none', '&foo=bar', '&redirect=https%3A%2F%2Fevil.example',
    '&Client_id=x', '&scope2=user%3Aprofile']) {
    assert.equal(checkLoginUrl(GOOD_LINK + extra), false, extra);
  }
  assert.equal(checkLoginUrl(swap('code=true&', '')), true, 'code is optional');
  assert.equal(checkLoginUrl(swap('&state=c3RhdGVzdGF0ZXN0YXRlc3RhdGVzdGF0ZQ', '')), true, 'state is optional');
  assert.equal(checkLoginUrl(`${GOOD_LINK}&state=x`), false, 'state at most once');
  assert.equal(checkLoginUrl(`${GOOD_LINK}&code=true`), false, 'code at most once');
  assert.equal(checkLoginUrl(`${GOOD_LINK}#frag`), false, 'no fragment');
});

test('PKCE is required: a code_challenge, and code_challenge_method S256 exactly once', () => {
  assert.equal(checkLoginUrl(swap('&code_challenge_method=S256', '')), false, 'no method');
  assert.equal(checkLoginUrl(swap('&code_challenge=Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5', '')), false, 'no challenge');
  assert.equal(checkLoginUrl(swap('code_challenge_method=S256', 'code_challenge_method=plain')), false, 'plain');
  assert.equal(checkLoginUrl(swap('code_challenge_method=S256', 'code_challenge_method=s256')), false, 'case');
  assert.equal(checkLoginUrl(`${GOOD_LINK}&code_challenge_method=S256`), false, 'doubled method');
  assert.equal(checkLoginUrl(`${GOOD_LINK}&code_challenge=Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5`), false, 'doubled challenge');
  assert.equal(checkLoginUrl(swap('code_challenge=Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5', 'code_challenge=short')), false, 'too short');
});
