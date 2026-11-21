/**
 * Font licence confirmation (#286). A custom font is licensed software, so a
 * member confirms they hold a licence that allows use on a website and
 * hosting by a third party before the file is stored. Pure: the App records
 * who accepted what (control plane `FontLicenceAcceptance`), Admin lists and
 * removes, this decides.
 *
 * The agreement is versioned like Menuza's own terms (#194): acceptance is per
 * member and per version, and raising `FONT_LICENCE_VERSION` asks everyone
 * again. Menuza's own agreement tables are not reused: they hold Menuza's
 * terms with owners, not a content licence per file.
 */
import {
	CUSTOM_SITE_FONT_ID,
	DEFAULT_SITE_THEME,
	parseSiteThemeConfig,
	serializeSiteThemeConfig,
} from './site-theme.ts'

export const FONT_LICENCE_VERSION = 1

export const FONT_ROLES = ['heading', 'body'] as const
export type FontRole = (typeof FONT_ROLES)[number]

export function isFontRole(value: unknown): value is FontRole {
	return value === 'heading' || value === 'body'
}

/** The English agreement text (the App translates it for the dialog). */
export const FONT_LICENCE_STATEMENT =
	'I confirm that I hold a licence that allows this font to be used on a website and hosted by a third party.'

export type FontLicenceDecision = 'ok' | 'font_agreement_required'

/**
 * Whether an upload may go ahead: the member already accepted this version, or
 * ticks the box now for this version. Anything else is
 * `font_agreement_required`, and nothing is stored.
 */
export function fontLicenceDecision(input: {
	/** Versions this member already accepted for the organization. */
	acceptedVersions: readonly number[]
	/** The box submitted with the upload. */
	ticked: unknown
	/** The version of the text the member saw. */
	tickedVersion: unknown
	current?: number
}): FontLicenceDecision {
	const current = input.current ?? FONT_LICENCE_VERSION
	if (input.acceptedVersions.includes(current)) return 'ok'
	const ticked = input.ticked === true || input.ticked === 'true'
	const version =
		typeof input.tickedVersion === 'string'
			? Number(input.tickedVersion)
			: input.tickedVersion
	return ticked && version === current ? 'ok' : 'font_agreement_required'
}

/**
 * The theme JSON with a custom font taken out, so the site returns to the
 * theme font (Inter) at once: fonts are loaded by reference, so nothing is
 * republished. Returns the same value when there was nothing to remove.
 */
export function removeCustomFontFromThemeJson(
	raw: string | null,
	roles: readonly FontRole[],
): { json: string | null; changed: boolean } {
	if (raw === null) return { json: null, changed: false }
	const theme = parseSiteThemeConfig(raw)
	let changed = false
	const next = { ...theme }
	for (const role of roles) {
		if (role === 'heading') {
			if (next.headingCustomFont || next.headingFont === CUSTOM_SITE_FONT_ID) {
				next.headingCustomFont = null
				next.headingFont = DEFAULT_SITE_THEME.headingFont
				changed = true
			}
		} else if (next.bodyCustomFont || next.bodyFont === CUSTOM_SITE_FONT_ID) {
			next.bodyCustomFont = null
			next.bodyFont = DEFAULT_SITE_THEME.bodyFont
			changed = true
		}
	}
	return changed
		? { json: serializeSiteThemeConfig(next), changed: true }
		: { json: raw, changed: false }
}

/** The custom fonts a theme uses, with their stored object keys. */
export function customFontsOf(raw: string | null): Array<{
	role: FontRole
	objectKey: string
	filename: string
}> {
	if (!raw) return []
	const theme = parseSiteThemeConfig(raw)
	const fonts: Array<{ role: FontRole; objectKey: string; filename: string }> =
		[]
	if (theme.headingCustomFont) {
		fonts.push({
			role: 'heading',
			objectKey: theme.headingCustomFont.objectKey,
			filename: theme.headingCustomFont.filename,
		})
	}
	if (theme.bodyCustomFont) {
		fonts.push({
			role: 'body',
			objectKey: theme.bodyCustomFont.objectKey,
			filename: theme.bodyCustomFont.filename,
		})
	}
	return fonts
}

/** SHA-256 of a file, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
