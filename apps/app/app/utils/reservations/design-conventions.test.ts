import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * New reservation UI follows `ui-design-conventions.md` part D: semantic theme
 * tokens only (no raw palette colors, hex colors or arbitrary tiny text) and
 * logical direction classes, so Arabic mirrors correctly. The design lint is
 * blind to both, so the files added for payments and experiences are checked
 * here.
 */

const APP = path.resolve(import.meta.dirname, '../..')

const FILES = [
	'components/reservations/payment-badge.tsx',
	'components/reservations/payment-panel.tsx',
	'components/reservations/header-controls.tsx',
	'components/reservations/policies/policies-screen.tsx',
	'components/reservations/policies/policy-sheet.tsx',
	'components/reservations/experiences/experiences-screen.tsx',
	'components/reservations/experiences/experience-create-sheet.tsx',
	'components/reservations/experiences/experience-editor.tsx',
	'components/reservations/experiences/schedule-sheet.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.policies.tsx',
	'routes/_app+/$orgSlug_+/reservations+/experiences.tsx',
	'routes/_app+/$orgSlug_+/reservations+/experiences.$id.tsx',
]

const RAW_COLOR =
	/\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:emerald|amber|slate|sky|blue|red|orange|yellow|gray|zinc|green)-\d/
const HEX = /\[#[0-9a-fA-F]{3,8}\]/
const TINY_TEXT = /text-\[1\d?px\]/
const PHYSICAL =
	/(?:^|[\s"'`:])-?(?:ml|mr|pl|pr)-(?:\d|px|auto)|text-(?:left|right)\b|(?:^|[\s"'`:])(?:left|right)-\d|rounded-(?:l|r|tl|tr|bl|br)-|border-(?:l|r)(?:-|\b)/m

describe('payments and experiences UI follows the design conventions', () => {
	for (const file of FILES) {
		const source = fs.readFileSync(path.join(APP, file), 'utf8')
		it(`${file}: tokens only, logical direction`, () => {
			expect(source).not.toMatch(RAW_COLOR)
			expect(source).not.toMatch(HEX)
			expect(source).not.toMatch(TINY_TEXT)
			expect(source).not.toMatch(PHYSICAL)
		})
		// The layout header controls are the existing header markup, moved as is.
		it.skipIf(file.endsWith('header-controls.tsx'))(
			`${file}: no native select, checkbox or table`,
			() => {
				expect(source).not.toMatch(/<select\b|<table\b|type="checkbox"/)
			},
		)
		it(`${file}: no hard-coded locale`, () => {
			expect(source).not.toMatch(/en-GB|en-US/)
		})
	}
})
