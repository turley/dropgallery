# DropGallery

A CLI that turns a selection of images and videos into a single shareable static gallery hosted on S3 + CloudFront. Built primarily for macOS (Finder selection → Apple Shortcut → native dialogs), with a cross-platform terminal mode for Linux and Windows.

## Motivation

Yes, there are countless tools for making photo galleries out there, and this is another one. But this one is great because it covers what I wanted:

- Hosted on my own S3 bucket + CloudFront distribution
- Uses my own domain (e.g. `gallery.mydomain.com`) with TLS
- Produces statically-generated galleries (no server-side processing)
- Generates random, unguessable URLs (easily shared, but still private)
- Optional expiration (1, 7, 30 days, or never)
- Supports images and videos
- Minimal design - no logins, tracking, analytics, or other fluff
- Easy to integrate into macOS Finder (and still usable on other platforms)

## What it does

```
files → prompts (confirm / title / expiration)
      → sharp + ffmpeg generate thumbnails
      → render dark-themed PhotoSwipe gallery
      → upload to S3 with expire-days tags
      → CloudFront URL → clipboard
```

- 1, 7, 30-day, or never expirations (S3 lifecycle rules do the actual deletion)
- Dark-themed responsive grid with a click-to-expand lightbox (PhotoSwipe v5)
- HEIC/HEIF/AVIF auto-converted to JPEG so non-Safari browsers display them
- Videos get a real poster frame if `ffmpeg` is on PATH, a placeholder otherwise
- One unguessable URL per gallery (128-bit base64url ID); URLs are the only access control
- macOS: native AppleScript dialogs + a Notification Center toast when work begins
- Linux / Windows: terminal prompts (`@inquirer/prompts`) + ora spinner

## Prerequisites

- **Node.js ≥ 20** (LTS) on macOS, Linux, or Windows
- **AWS account** + a way to attach a custom TLS domain
- **`ffmpeg`** (optional but recommended for video posters):
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg` / `dnf install ffmpeg`
  - Windows: <https://ffmpeg.org/download.html>
- **macOS only**: uses built-in `osascript`, `pbcopy`, `open` — no install needed

## One-time AWS setup

You only do this once; the script then runs against your bucket on every gallery upload.

### 1. S3 bucket

- Create a **new** S3 bucket dedicated to this tool.
- **Block all public access** (default).

### 2. CloudFront distribution

- Create a CloudFront distribution.
- **Origin**: the S3 bucket above. Use **OAC (Origin Access Control)** so the bucket stays private and only CloudFront can read it.
- **Custom TLS domain** (e.g. `gallery.yourdomain.com`): attach an ACM certificate issued in **us-east-1** (CloudFront only consumes us-east-1 certs).
- **Error responses**: configure 404 (and optionally 403) to return a small static error page or accept CloudFront's default. **Do not enable directory listing** — the bucket has no listings via OAC and CloudFront should not invent any. This keeps `/g/` from being enumerable.

No CloudFront Functions or Lambda@Edge needed. Each gallery's HTML is uploaded to the bare key `g/<id>` (no extension) with `Content-Type: text/html`, and a `<base href="<id>/">` in the HTML makes relative paths to `images/`, `thumbnails/`, and `photoswipe/` resolve correctly against the served URL.

After creation, CloudFront takes ~5–15 minutes to deploy globally; URLs may 404 until then.

### 3. Lifecycle rules (the expiration mechanism)

On the bucket, create **three** lifecycle rules. Each is filtered by exactly one tag value and expires matching objects:

| Rule name       | Tag filter       | Expire current versions after |
| --------------- | ---------------- | ----------------------------- |
| `expire-1day`   | `expire-days=1`  | 1 day                         |
| `expire-7days`  | `expire-days=7`  | 7 days                        |
| `expire-30days` | `expire-days=30` | 30 days                       |

**Do not** create a bucket-wide catch-all rule — galleries with the "Never" expiration carry no tag, and a catch-all would defeat that.

### 4. IAM credentials

Create an IAM user (or role) with this minimal policy on the bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectTagging"],
      "Resource": "arn:aws:s3:::your-gallery-bucket/*"
    }
  ]
}
```

Add the access keys to `~/.aws/credentials` under a named profile:

```
[gallery]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

The script never reads raw access keys — it loads the profile via the AWS SDK.

## Install

Once the AWS prerequisites above are in place:

```bash
npm install -g dropgallery
dropgallery --setup
```

`dropgallery --setup` walks you through the four config values (profile, region, bucket name, CloudFront domain), validates them against AWS via `HeadBucket`, and writes the config to the OS-standard application config directory:

- macOS: `~/Library/Preferences/dropgallery/galleryrc`
- Linux: `~/.config/dropgallery/galleryrc`
- Windows: `%APPDATA%\dropgallery\Config\galleryrc`

If you prefer a dotfile in your home directory, `~/.galleryrc` is checked first and wins if it exists. The format is dotenv:

```
AWS_PROFILE=gallery
AWS_REGION=us-east-1
S3_BUCKET=your-gallery-bucket
CLOUDFRONT_DOMAIN=gallery.yourdomain.com
```

You can re-run `dropgallery --setup` any time to regenerate the config.

### Installing from source (development)

```bash
git clone https://github.com/turley/dropgallery.git
cd dropgallery
npm install
node gallery.js --setup        # or: npm link && dropgallery --setup
```

## Apple Shortcut (macOS)

A small wrapper that hands the selected Finder files (or folders) to the `dropgallery` command.

### Build the shortcut

1. Open **Shortcuts.app** → **File → New Shortcut** (or click `+`).
2. Name it **Make Gallery** at the top of the editor.
3. Click the small **ⓘ** ("info") button in the editor's toolbar to reveal the **Shortcut Details** panel on the right.
4. In the Details panel:
   - Toggle on **Use as Quick Action**.
   - Check **Finder** (and **Services Menu** if you want the keyboard-shortcut binding below).
   - Set **Receive** to **Files, Folders** (so the action shows up for both individual files and folders selected in Finder).
5. macOS auto-inserts a **Receive [Files, Folders] from Quick Actions** step at the top of the workflow. Leave it.
6. Drag a **Run Shell Script** action below it. Configure:
   - **Shell:** `zsh`
   - **Pass Input:** **as arguments**
   - **Script:**
     ```sh
     export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin:$PATH"
     dropgallery "$@"
     ```
     The `PATH` line covers the three common places `npm install -g` puts the bin: Apple Silicon Homebrew (`/opt/homebrew/bin`), Intel Homebrew or system Node (`/usr/local/bin`), and nvm (`~/.nvm/...`). Run `which dropgallery` in your terminal to confirm where yours lives.
   - Make sure the **Input** field is set to **Shortcut Input**, along with **Pass input as arguments**.
7. Save (`⌘S`).

### Use it

Select files **or a folder** in Finder, right-click → **Quick Actions** → **Make Gallery** (it may live under a "More…" submenu if you have many Quick Actions). When a folder is selected, `dropgallery` recursively walks it and picks up everything with a supported extension (`.jpg/.jpeg/.png/.webp/.gif/.heic/.heif/.avif/.mp4/.mov`); `.DS_Store` and other dotfiles are skipped. You can also pass multiple files, multiple folders, or a mix.

### Optional: keyboard shortcut

**System Settings → Keyboard → Keyboard Shortcuts → Services → Files and Folders → Make Gallery** → assign something like `⌥⌘G`.

## Usage from terminal

```bash
dropgallery path/to/a.jpg path/to/b.heic path/to/c.mp4
dropgallery path/to/folder                          # walks recursively, picks up images and videos
dropgallery folder1 folder2 some-loose-photo.jpg    # mix is fine
```

On macOS, this runs the same native dialogs as the Apple Shortcut path.

To force the terminal UI on macOS (useful for unattended scripts or to avoid GUI dialogs entirely), pass `--cli`:

```bash
dropgallery --cli path/to/a.jpg path/to/b.heic
```

`--cli` is also the default — and only — mode on Linux and Windows. The same flag, or setting `DROPGALLERY_UI=cli` in the environment, opts you in explicitly on macOS too.

## Logs

Every run writes a timestamped `.log` file in the OS-appropriate log directory:

- macOS: `~/Library/Logs/dropgallery/`
- Linux: `~/.local/share/dropgallery/log/`
- Windows: `%LOCALAPPDATA%\dropgallery\Log\`

Successful runs use a short format; failure runs include the full stack trace plus any captured `ffmpeg` / AWS SDK output. Logs are not auto-rotated; clean them out periodically if you care.

## Troubleshooting

- **"AWS auth failure" / SignatureDoesNotMatch** — check the profile name in your config (`~/Library/Preferences/dropgallery/galleryrc` on macOS) matches a section in `~/.aws/credentials`, and that the IAM policy grants `s3:PutObject` and `s3:PutObjectTagging` on the bucket. Re-running `dropgallery --setup` validates this for you.
- **Gallery URL returns 404** — CloudFront takes 5–15 minutes to deploy after first creation. After that, check OAC is correctly attached and the bucket policy grants read to the CloudFront principal. Verify the gallery's HTML object exists in the S3 console at the bare key `g/<id>` (no extension).
- **Object not expiring** — check the lifecycle rule's tag filter is `expire-days=N` (no spaces); inspect actual tags via `aws s3api get-object-tagging --bucket your-gallery-bucket --key g/<id>` (the HTML) or `--key g/<id>/images/<file>` (an asset).
- **Videos show placeholder instead of poster frame** — `ffmpeg` isn't on `$PATH` in the Shortcut's environment. The Shortcut runs with a minimal `$PATH`; either install ffmpeg into `/usr/local/bin` (older Homebrew) or `/opt/homebrew/bin` (Apple Silicon Homebrew), or update the shell-script action to set `PATH` explicitly.
- **HEIC files fail to convert** — sharp's prebuilt binaries should bundle libheif on macOS. If conversion fails, run `npm rebuild sharp` or `npm install sharp@latest`.
- **(Linux) `clipboardy` errors with "Cannot find xclip / wl-copy"** — the cross-platform clipboard library shells out to system tools. Install one: `apt install xclip` (X11) or `apt install wl-clipboard` (Wayland). On Windows, no extra install is needed.
- **(Linux) `Sharp install failed`** — older glibc / Alpine setups need an explicit `npm install --include=optional sharp` or system libvips. See [sharp's install docs](https://sharp.pixelplumbing.com/install).

## Out of scope (intentionally)

- Password-protected galleries / signed URLs — URL unguessability is the only access control
- Analytics, upload UI, albums, EXIF display, sort by date
- Automatic log rotation

## License

MIT — see [LICENSE](./LICENSE).

PhotoSwipe v5 is vendored in `templates/photoswipe/` and retains its own MIT license — see [templates/photoswipe/LICENSE](./templates/photoswipe/LICENSE).
