# Photography Portfolio

A minimal photo website that builds itself from a folder. You never edit code to add photos.

## Adding photos (daily use)

**Option A: in the browser (from anywhere, even your phone)**
1. Go to `https://7benni.github.io/Website-MAC/admin/`.
   The first time on a device, paste your GitHub access key (see setup below). The device remembers it.
2. Drag photos (or a whole folder; it becomes an album) onto the page.
3. Pick an album or type a new name, then click **Upload**.
4. After about 1–2 minutes the page says **Live!**

In the admin you can also:
- **★** add a photo to the homepage slideshow (several photos crossfade; none starred = newest landscape photo)
- **◎** set a focus point: tap the most important spot, and crops on phones and album covers keep it in view
- **◩** set the album cover, **✕** delete a photo, and give albums an English and a German title and description

**Option B: on your Mac**
1. Drag photos into `photos/<Album name>/`. A new folder means a new album.
2. Double-click **Publish.command**. Done.

Good to know:
- Photos are sorted newest first, by the date your camera saved in the file.
- Upload your normal JPG exports. Large photos are automatically shrunk to 3000px before upload
  (enough for the website and keeps the repository small). Your originals on your Mac stay untouched
  when you upload via the browser.
- **GPS/location data is removed** before anything is uploaded, because the repository is public. Camera info stays.
- HEIC (iPhone) files are not supported. Export them as JPG.

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
| `hero` | Homepage slideshow, e.g. `["Landscapes/iceland.jpg", "Street/tokyo.jpg"]` (empty = newest landscape photo). Easiest via ★ in admin |
| `monogram` | Optional: letters for the logo/icon (default: your initials from `name`) |
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

## One-time setup (about 10 minutes)

### 1. Make the repository public
GitHub Pages is free only for public repositories.
GitHub → your repository → **Settings → General → Danger Zone → Change visibility → Public**.
Only web-sized photos without location data end up there; your code contains no secrets.

### 2. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source: GitHub Actions**.
Every change (upload, Publish.command, admin action) now rebuilds and publishes the site automatically.
Progress is visible in the **Actions** tab.

Your site: `https://7benni.github.io/Website-MAC/`

### 3. Create the admin access key
1. Open the admin page and click *“No key yet? Create one”*. The link opens GitHub with most fields filled in.
   (Or go to GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens → Generate new token**.)
2. Expiration: up to 1 year.
3. Repository access: **Only select repositories → Website-MAC**.
4. Permissions → Repository permissions → **Contents: Read and write**.
5. **Generate token**, copy it, paste it into the admin page.

The key only works for this one repository. Treat it like a password. If it leaks, delete it on GitHub
and create a new one.

### Later: own domain or own server
- **Own domain** (e.g. `benjaminkrause.de`): Settings → Pages → Custom domain. Nothing else to change.
- **Own server / Raspberry Pi**: `npm run build` creates a ready-to-serve `dist/` folder that any web server can serve.

## How it works (for the curious)

- `scripts/build.mjs` reads `photos/`, creates WebP images in three sizes, reads EXIF, and writes static HTML to `dist/`. Processed images are cached, so a rebuild only handles new photos.
- `src/templates.mjs` holds the page layouts, and `src/assets/` the CSS and JavaScript (lightbox, theme/language toggle, admin).
- `.github/workflows/deploy.yml` builds and publishes the site on GitHub Pages after every commit.
- The admin talks directly to the GitHub API with your access key and commits photos to the repository.
- `src/assets/exif-clean.js` removes GPS location while keeping camera info, used by the admin and by `scripts/prepare.mjs` (Publish.command).
- Fonts are self-hosted (no Google Fonts requests). The site has no cookies and no tracking.
