import { type TailwindConfig } from '@react-email/components'
import { brand } from '@repo/config/brand'

/**
 * Absolute URL of the brand mark used in email headers.
 *
 * Points at the raster favicon served by the marketing app on the apex origin.
 * Email clients — Gmail above all — do not render SVG images, so `favicon.svg`
 * is not usable in `<img>`. We serve `email-logo.png` on the marketing site: a
 * 128×128 raster exported from the same SVG (see `apps/web/public/favicons/`).
 * Display size in the header is {@link emailBrandLogoSize}px (≈4× for retina).
 */
export const emailBrandLogoSize = 32

export const emailBrandLogoUrl = new URL(
	'/favicons/email-logo.png',
	brand.url,
).toString()

/**
 * Email mirror of the app's shadcn theme tokens.
 *
 * Email clients understand neither `oklch()` nor CSS custom properties, so each
 * value below is the literal sRGB equivalent of the `:root` block in
 * `apps/app/app/styles/tailwind.css`, converted with `oklchToHex()` from
 * `@repo/common/email-theme`. Keep the two in sync if the app theme changes.
 */
export const emailThemeColors = {
	background: '#ffffff', // oklch(1 0 0)
	foreground: '#0a0a0a', // oklch(0.145 0 0)
	card: '#ffffff', // oklch(1 0 0)
	'card-foreground': '#0a0a0a', // oklch(0.145 0 0)
	secondary: '#f4f4f5', // oklch(0.967 0.001 286.375)
	'secondary-foreground': '#18181b', // oklch(0.21 0.006 285.885)
	muted: '#f5f5f5', // oklch(0.97 0 0)
	'muted-foreground': '#737373', // oklch(0.556 0 0)
	accent: '#f5f5f5', // oklch(0.97 0 0)
	'accent-foreground': '#171717', // oklch(0.205 0 0)
	primary: '#009869', // oklch(0.6 0.13 163)
	'primary-foreground': '#edfdf5', // oklch(0.98 0.02 166)
	destructive: '#df2225', // oklch(0.58 0.22 27)
	'destructive-foreground': '#fafafa', // oklch(0.985 0 0)
	border: '#e5e5e5', // oklch(0.922 0 0)
	input: '#e5e5e5', // oklch(0.922 0 0)
	ring: '#a1a1a1', // oklch(0.708 0 0)
} as const

/**
 * The email type scale, ported from the React Email demo this layout is modelled
 * on (`apps/demo/emails/01-Barebone/theme.ts`).
 *
 * Each step carries its own leading and tracking, which is most of why the
 * reference reads as polished: sizes alone are not enough. Two deliberate
 * differences from the source:
 *
 * - **No `fontWeight` in the tokens.** The reference bakes weight into its
 *   `.font-N` utilities because it never mixes a size with a weight class. We do
 *   (`font-medium` on a button, `font-semibold` on a heading), and baking weight
 *   in would put two `font-weight` declarations on one element and make the
 *   winner an implementation detail. Weights are set explicitly instead.
 * - **No `pixelBasedPreset`.** It ships from the `react-email` CLI package, which
 *   this package does not depend on.
 */
type EmailFontSizeStep = [
	fontSize: string,
	{ lineHeight: string; letterSpacing: string },
]

export const emailFontSize: Record<string, EmailFontSizeStep> = {
	11: ['11px', { lineHeight: '1.5', letterSpacing: '-0.033px' }],
	13: ['13px', { lineHeight: '1.5', letterSpacing: '-0.039px' }],
	16: ['16px', { lineHeight: '1.5', letterSpacing: '-0.048px' }],
	24: ['24px', { lineHeight: '1', letterSpacing: '-0.084px' }],
	28: ['28px', { lineHeight: '1.3', letterSpacing: '-0.084px' }],
	32: ['32px', { lineHeight: '1.25', letterSpacing: '-0.64px' }],
	40: ['40px', { lineHeight: '1.1', letterSpacing: '-0.8px' }],
}

/**
 * Passed to React Email's `<Tailwind config={...}>` so templates can use the same
 * semantic class names as the app (`bg-card`, `text-muted-foreground`, ...).
 *
 * Keep this module-level: a config re-created per render forces React Email to
 * rebuild its Tailwind instance on every email.
 */
export const emailTailwindConfig = {
	theme: {
		extend: {
			colors: emailThemeColors,
			fontSize: emailFontSize,
			// Matches the marketing-email stack (`email-theme.ts` fallback) so both
			// email subsystems render the same type.
			fontFamily: {
				sans: ['Inter', 'Helvetica', 'Arial', 'sans-serif'],
			},
			// The boxed layout has fixed padding that is too generous on a phone.
			// Email clients do not reliably honour a viewport meta tag, so this
			// collapses the padding on its own below the sheet width.
			screens: {
				mobile: { max: '600px' },
			},
		},
	},
} satisfies TailwindConfig
