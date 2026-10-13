// Step 1 of "Sign in with GitHub": send the browser to GitHub's login page.
export default async (req) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return new Response('GITHUB_CLIENT_ID is not set in Netlify environment variables.', { status: 500 });

  const state = crypto.randomUUID();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', process.env.GITHUB_SCOPE || 'repo');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', new URL('/auth/callback', req.url).href);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
};

export const config = { path: '/auth' };
