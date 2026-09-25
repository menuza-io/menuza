# @repo/config

Centralized configuration for the Menuza monorepo.

## Brand Configuration

All brand-related strings, descriptions, and metadata are centralized in
`brand.ts`. This ensures consistency across all apps and makes rebranding a
breeze.

### Usage

```typescript
import {
	brand,
	getPageTitle,
	getCopyright,
	getBrandDomain,
	getBrandTeam,
} from '@repo/config/brand'

// Use brand name
console.log(brand.name) // "Menuza"
console.log(brand.slug) // "menuza"
console.log(brand.domain) // "menuza.io"
console.log(getBrandDomain()) // "menuza.io"

// Generate page titles
const title = getPageTitle('Login') // "Login | Menuza"

// Use product-specific descriptions
const appDescription = brand.products.app.description

// Email subjects
const subject = brand.email.welcome // "Welcome to Menuza!"

// Copyright text
const copyright = getCopyright() // "© 2025 Menuza. All rights reserved."
```

### What's Centralized

- **Core Identity**: Brand name, slug, app domain, tagline, description
- **URLs**: Main URL, support email
- **Product Descriptions**: App-specific names and descriptions
- **Email Subjects**: Standardized email subject lines
- **AI Configuration**: System prompts for AI assistants
- **Legal**: Company name, copyright year

### Updating the Brand

To rebrand your entire application:

1. Run `npm run setup:brand` (asks for name, short name, **app domain** such as
   `.me` / `.io` / `.dev`, then website URL and support email)
2. Or edit `packages/config/brand.ts` (`name`, `slug`, `domain`, …)
3. Rebuild with `npm run build --workspace=@repo/config` if you edited
   `brand.ts` by hand
4. All apps will use the new values (hosts/SSL/dev-proxy read `getLocalDomain()`
   and its derived `.test` hostname)

## Favicons & Static Assets

For favicons and other static assets that need to be shared:

### Option 1: Shared Static Package (Recommended)

Create a `packages/static` package with shared assets:

```
packages/static/
  ├── favicons/
  │   ├── favicon.ico
  │   ├── android-chrome-192x192.png
  │   └── android-chrome-512x512.png
  ├── images/
  │   └── logo.svg
  └── package.json
```

Then copy them during build or reference them directly.

### Option 2: Build-time Copy

Use a build script to copy shared assets from a central location to each app's
public folder.

### Option 3: CDN/Static Host

Host shared assets on a CDN and reference them by URL in all apps.

## ESLint Configuration

Import the shared ESLint preset:

```javascript
import eslintPreset from '@repo/config/eslint-preset'

export default eslintPreset
```
