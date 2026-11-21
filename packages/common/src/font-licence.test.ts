import { describe, expect, it } from 'vitest'
import {
	customFontsOf,
	FONT_LICENCE_VERSION,
	fontLicenceDecision,
	removeCustomFontFromThemeJson,
	sha256Hex,
} from './font-licence.ts'
import { DEFAULT_SITE_THEME, serializeSiteThemeConfig } from './site-theme.ts'

const themeWithFonts = serializeSiteThemeConfig({
	...DEFAULT_SITE_THEME,
	headingFont: 'custom',
	bodyFont: 'custom',
	headingCustomFont: {
		objectKey: 'org/o1/site-fonts/heading/1-a.woff2',
		filename: 'Brand.woff2',
		format: 'woff2',
	},
	bodyCustomFont: {
		objectKey: 'org/o1/site-fonts/body/1-b.woff2',
		filename: 'Body.woff2',
		format: 'woff2',
	},
})

describe('fontLicenceDecision', () => {
	it('refuses an upload without the box ticked', () => {
		expect(
			fontLicenceDecision({
				acceptedVersions: [],
				ticked: undefined,
				tickedVersion: undefined,
			}),
		).toBe('font_agreement_required')
		expect(
			fontLicenceDecision({
				acceptedVersions: [],
				ticked: 'false',
				tickedVersion: String(FONT_LICENCE_VERSION),
			}),
		).toBe('font_agreement_required')
	})
	it('allows a ticked box for the current version', () => {
		expect(
			fontLicenceDecision({
				acceptedVersions: [],
				ticked: 'true',
				tickedVersion: String(FONT_LICENCE_VERSION),
			}),
		).toBe('ok')
	})
	it('refuses a tick for an older text', () => {
		expect(
			fontLicenceDecision({
				acceptedVersions: [],
				ticked: 'true',
				tickedVersion: '0',
			}),
		).toBe('font_agreement_required')
	})
	it('does not ask again once this version was accepted', () => {
		expect(
			fontLicenceDecision({
				acceptedVersions: [FONT_LICENCE_VERSION],
				ticked: undefined,
				tickedVersion: undefined,
			}),
		).toBe('ok')
	})
	it('asks again when the text changes', () => {
		expect(
			fontLicenceDecision({
				acceptedVersions: [1],
				ticked: undefined,
				tickedVersion: undefined,
				current: 2,
			}),
		).toBe('font_agreement_required')
	})
})

describe('removeCustomFontFromThemeJson', () => {
	it('falls back to the theme font for the removed role only', () => {
		const result = removeCustomFontFromThemeJson(themeWithFonts, ['heading'])
		expect(result.changed).toBe(true)
		const parsed = JSON.parse(result.json!)
		expect(parsed.headingCustomFont).toBeNull()
		expect(parsed.headingFont).toBe('inter')
		expect(parsed.bodyCustomFont).not.toBeNull()
		expect(parsed.bodyFont).toBe('custom')
	})
	it('removes both and leaves nothing to load by reference', () => {
		const result = removeCustomFontFromThemeJson(themeWithFonts, [
			'heading',
			'body',
		])
		expect(customFontsOf(result.json)).toEqual([])
	})
	it('changes nothing when there is no custom font', () => {
		const plain = serializeSiteThemeConfig(DEFAULT_SITE_THEME)
		expect(removeCustomFontFromThemeJson(plain, ['heading', 'body'])).toEqual({
			json: plain,
			changed: false,
		})
		expect(removeCustomFontFromThemeJson(null, ['body'])).toEqual({
			json: null,
			changed: false,
		})
	})
})

describe('customFontsOf and sha256Hex', () => {
	it('lists the fonts with their keys', () => {
		expect(customFontsOf(themeWithFonts).map((font) => font.role)).toEqual([
			'heading',
			'body',
		])
	})
	it('hashes a file', async () => {
		expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})
})
