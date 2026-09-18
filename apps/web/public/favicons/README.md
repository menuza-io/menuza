# Favicon

This directory has the icons used for android devices. In some cases, we cannot
reliably detect light/dark mode preference. Hence these icons should not have a
transparent background. These icons are referenced in the `site.webmanifest`
file.

The icons used by modern browsers and Apple devices are in `app/assets/favicons`
as they can be imported with a fingerprint to bust the browser cache.

Note, there's also a `favicon.ico` in the root of `/public` which some older
browsers will request automatically. This is a fallback for those browsers.

`email-logo.png` is a 128×128 raster of `favicon.svg` (primary brand color) for
transactional email headers. Regenerate after SVG changes:

```bash
node --input-type=module -e "
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const svg = readFileSync('apps/web/public/favicons/favicon.svg','utf8').replaceAll('currentColor','#009869');
await sharp(Buffer.from(svg), { density: 384 }).resize(128,128,{ fit:'contain', background:{ r:0,g:0,b:0,alpha:0 }}).png().toFile('apps/web/public/favicons/email-logo.png');
"
```
