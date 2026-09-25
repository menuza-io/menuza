# Performance Monitoring

The Menuza marketing website enforces strict performance budgets to ensure a
fast, accessible experience for all users.

## Performance Requirements

| Metric         | Minimum Score |
| -------------- | ------------- |
| Performance    | 98            |
| Accessibility  | 98            |
| Best Practices | 98            |
| SEO            | 98            |

## Core Web Vitals Targets

| Metric | Target  | Description              |
| ------ | ------- | ------------------------ |
| LCP    | ≤ 2.5s  | Largest Contentful Paint |
| FID    | ≤ 100ms | First Input Delay        |
| CLS    | ≤ 0.1   | Cumulative Layout Shift  |
| FCP    | ≤ 1.5s  | First Contentful Paint   |
| TTFB   | ≤ 600ms | Time to First Byte       |
| TBT    | ≤ 200ms | Total Blocking Time      |
| SI     | ≤ 3s    | Speed Index              |

## How It Works

### 1. Preview Deployments

Every pull request that modifies the web app triggers:

1. **Build** - The web app is built
2. **Deploy** - Deployed to Cloudflare Pages as a preview
3. **Lighthouse Audit** - Runs 3 times per page for accuracy
4. **Performance Gate** - Fails if any score drops below 98

### 2. GitHub Actions Workflow

The `lighthouse.yml` workflow:

```
PR Created/Updated
       ↓
Preview Deploy to Cloudflare
       ↓
Wait for deployment ready
       ↓
Run Lighthouse CI (3 runs × 3 pages)
       ↓
Assert scores ≥ 98
       ↓
Comment results on PR
       ↓
Pass/Fail check
```

### 3. Configuration Files

- `apps/web/lighthouserc.js` - Lighthouse CI configuration
- `apps/web/performance-budget.json` - Resource budgets and targets

## Required GitHub Secrets

| Secret                  | Description                          |
| ----------------------- | ------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token                 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                |
| `LHCI_GITHUB_APP_TOKEN` | (Optional) For Lighthouse GitHub App |

## Running Lighthouse Locally

```bash
# Install Lighthouse CI
npm install -g @lhci/cli

# Build the web app
cd apps/web
npm run build

# Start preview server
npm run preview

# Run Lighthouse
lhci autorun --config=lighthouserc.js --collect.url=http://localhost:4321
```

## Optimizing Performance

### Common Issues & Fixes

1. **Large JavaScript bundles**
   - Use dynamic imports for non-critical code
   - Check for unused dependencies

2. **Render-blocking resources**
   - Inline critical CSS
   - Defer non-critical scripts

3. **Unoptimized images**
   - Use WebP/AVIF formats
   - Implement lazy loading
   - Set explicit width/height

4. **Layout shifts**
   - Reserve space for dynamic content
   - Use `aspect-ratio` for images
   - Avoid inserting content above existing content

5. **Third-party scripts**
   - Defer analytics scripts
   - Use `dns-prefetch` for external domains
   - Consider self-hosting critical assets

### Astro-Specific Optimizations

```astro
---
// Use Astro's built-in image optimization
import { Image } from 'astro:assets';
import heroImage from '../assets/hero.jpg';
---

<!-- Optimized image with automatic format conversion -->
<Image
  src={heroImage}
  alt="Hero"
  width={1200}
  height={600}
  loading="eager"
  fetchpriority="high"
/>

<!-- Lazy load below-the-fold images -->
<Image
  src={otherImage}
  alt="Other"
  loading="lazy"
/>
```

## Monitoring Production

For production monitoring, consider:

1. **Real User Monitoring (RUM)**
   - Cloudflare Web Analytics (free)
   - Google Analytics 4 with Web Vitals

2. **Synthetic Monitoring**
   - Scheduled Lighthouse runs
   - PageSpeed Insights API

3. **Alerting**
   - Set up alerts for score regressions
   - Monitor Core Web Vitals in Search Console
