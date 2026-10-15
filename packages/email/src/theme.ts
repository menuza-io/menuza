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
	background: '#fbfaf8', // oklch(0.985 0.003 85)
	foreground: '#1d1c1a', // oklch(0.227 0.004 85)
	card: '#ffffff', // oklch(1 0 0)
	'card-foreground': '#1d1c1a', // oklch(0.227 0.004 85)
	secondary: '#f6f5f2', // oklch(0.97 0.004 91)
	'secondary-foreground': '#1d1c1a', // oklch(0.227 0.004 85)
	muted: '#f6f5f2', // oklch(0.97 0.004 91)
	'muted-foreground': '#6b6760', // oklch(0.515 0.012 82)
	accent: '#f2f1ed', // oklch(0.958 0.005 91)
	'accent-foreground': '#1d1c1a', // oklch(0.227 0.004 85)
	primary: '#305d3d', // oklch(0.437 0.073 152)
	'primary-foreground': '#ffffff', // oklch(1 0 0)
	destructive: '#b23c30', // oklch(0.524 0.156 29)
	'destructive-foreground': '#ffffff', // oklch(1 0 0)
	border: '#e9e7e2', // oklch(0.928 0.007 89)
	input: '#dad7d0', // oklch(0.88 0.01 88)
	ring: '#305d3d', // oklch(0.437 0.073 152)
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
