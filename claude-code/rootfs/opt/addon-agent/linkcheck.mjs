// The sign-in link and login-code checks. Shared by the server (seat.mjs) and the page
// (served as-is to the browser), so both sides refuse exactly the same things.
// Fail closed: anything not described here is refused, including a scope a newer
// Claude Code asks for.

export const LINK_RE =
  /^https:\/\/claude\.(?:com|ai)\/[A-Za-z0-9/_-]*oauth\/authorize\?[A-Za-z0-9._~%&=+:/?#-]+$/;
export const LINK_IN_TEXT_RE = /https:\/\/claude\.(com|ai)\/\S*oauth\/authorize\?\S+/;
export const CODE_RE = /^[A-Za-z0-9_.~#-]{8,600}$/;

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const SCOPES = [
  'org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code',
  'user:mcp_servers', 'user:file_upload', 'user:plugins',
];

// The only query keys a sign-in link may carry; each at most once. All but code and
// state are required, and PKCE (code_challenge with method S256) is required.
export const KEYS = ['code', 'client_id', 'response_type', 'redirect_uri', 'scope', 'code_challenge',
  'code_challenge_method', 'state'];
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

export function checkLoginUrl(url) {
  if (typeof url !== 'string' || !LINK_RE.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  const params = parsed.searchParams;
  const seen = [...params.keys()];
  if (seen.some((k) => !KEYS.includes(k)) || new Set(seen).size !== seen.length) return false;
  const one = (k) => {
    const all = params.getAll(k);
    return all.length === 1 ? all[0] : null;
  };
  if (!CHALLENGE_RE.test(one('code_challenge') ?? '')) return false;
  if (one('code_challenge_method') !== 'S256') return false;
  if (one('client_id') !== CLIENT_ID) return false;
  if (one('redirect_uri') !== REDIRECT_URI) return false;
  if (one('response_type') !== 'code') return false;
  const scope = one('scope');
  if (scope === null) return false;
  const scopes = scope.split(' ');
  return scopes.length > 0 && scopes.every((s) => SCOPES.includes(s));
}

export function checkCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}
