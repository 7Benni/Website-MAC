# Photography Portfolio

A minimal photo website that builds itself from a folder. You never edit code to add photos.

## Adding photos (daily use)

**Option A: in the browser (from anywhere, even your phone)**
1. Go to `https://<your-site>/admin` and click **Sign in with GitHub**.
2. Drag photos (or a whole folder; it becomes an album) onto the page.
3. Pick an album or type a new name, then click **Upload**.
4. After about 1–2 minutes the page says **Live!**

In the admin you can also delete photos, set an album cover (◩), choose the homepage hero image (★),
and give albums an English and a German title and description.

**Option B: on your Mac**
1. Drag photos into `photos/<Album name>/`. A new folder means a new album.
2. Double-click **Publish.command**. Done.

Good to know:
- Photos are sorted newest first, by the date your camera saved in the file.
- Upload your normal JPG exports. Large files are fine; the website makes small, fast versions itself.
- HEIC (iPhone) files are not supported. Export them as JPG.
- GPS/location data is **removed** from the photos shown on the website.

## Preview on your Mac

```bash
npm install     # once
npm run dev     # then open http://localhost:3000
```

The preview updates automatically when you add photos or edit `site.json`.

## Settings: `site.json`

| Field | What it does |
|---|---|
| `name` | Your name: logo, homepage title |
| `tagline`, `description` | Short texts under your name (EN + DE) |
| `defaultLanguage` | `"en"` or `"de"` (visitors' browser language is used if it is EN/DE) |
| `hero` | Homepage photo, e.g. `"Landscapes/iceland.jpg"` (empty = newest landscape photo). Also settable via ★ in admin |
| `latestCount` | How many photos the "Latest" section shows |
| `about.photo` | Photo for the About page, e.g. `"Portraits/me.jpg"` |
| `about.text` | About text (EN + DE, new line = new paragraph) |
| `contact.email`, `contact.instagram` | Shown on About page and in the footer |
| `imprint` | Impressum text. When filled, an Imprint page appears (required in Germany for most public sites) |

Per album (optional), `photos/<Album>/_album.json`. The admin writes it for you:
```json
{ "title": { "en": "Landscapes", "de": "Landschaften" }, "description": { "en": "…", "de": "…" }, "cover": "iceland.jpg", "order": 1 }
```
`order` pins albums to a position; otherwise the album with the newest photos comes first.

## One-time setup (about 15 minutes)

### 1. Put the project on GitHub
Create a new repository on github.com (private is fine), for example `portfolio`. Then in this folder:
```bash
git remote add origin https://github.com/<you>/portfolio.git
git push -u origin main
```
(Or use GitHub Desktop: *Add existing repository*, then *Publish*.)

### 2. Connect Netlify
1. Create a free account on [netlify.com](https://netlify.com) (sign up with GitHub).
2. **Add new site → Import an existing project → GitHub** and choose your repository.
3. Keep the default settings (they come from `netlify.toml`) and click **Deploy**.
4. Note your site address, e.g. `https://benjamin-krause.netlify.app`. You can rename it or add your own domain later.

### 3. Enable "Sign in with GitHub" for the admin
1. Open [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**
   - Homepage URL: `https://<your-site>.netlify.app`
   - Authorization callback URL: `https://<your-site>.netlify.app/auth/callback`
2. Copy the **Client ID**, then click **Generate a new client secret** and copy it.
3. In Netlify: **Site configuration → Environment variables**, add:
   - `GITHUB_CLIENT_ID`: the client ID
   - `GITHUB_CLIENT_SECRET`: the secret
   - `ALLOWED_USERS`: your GitHub username (only you can sign in)
4. **Deploys → Trigger deploy**. Then open `/admin`.

If you add your own domain later, update both URLs in the GitHub OAuth App.

## How it works (for the curious)

- `scripts/build.mjs` reads `photos/`, creates WebP images in three sizes, reads EXIF, and writes static HTML to `dist/`. Processed images are cached, so a rebuild only handles new photos.
- `src/templates.mjs` holds the page layouts, and `src/assets/` the CSS and JavaScript (lightbox, theme/language toggle, admin).
- `netlify/functions/` handles the GitHub sign-in. The admin then commits photos straight to your repository, and every commit triggers a Netlify rebuild.
- Fonts are self-hosted (no Google Fonts requests). The site has no cookies and no tracking.
