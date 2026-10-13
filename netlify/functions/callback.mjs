// Step 2 of "Sign in with GitHub": exchange GitHub's one-time code for a token
// and hand it to the admin page (in the URL fragment, which never hits a server).
const back = (hash) => new Response(null, {
  status: 302,
  headers: {
    Location: `/admin/#${hash}`,
    'Set-Cookie': 'oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'Cache-Control': 'no-store',
  },
});

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = (req.headers.get('cookie') || '').match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) return back('error=state');

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL('/auth/callback', req.url).href,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) return back(`error=${encodeURIComponent(data.error || 'token')}`);

  // Optional extra lock: only these GitHub usernames may sign in (comma separated).
  const allowed = (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    const user = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'portfolio-admin' },
    }).then((r) => r.json()).catch(() => ({}));
    if (!allowed.includes(String(user.login || '').toLowerCase())) return back('error=not_allowed');
  }

  return back(`token=${data.access_token}`);
};

export const config = { path: '/auth/callback' };
