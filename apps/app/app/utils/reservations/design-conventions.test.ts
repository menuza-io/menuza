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
	'components/reservations/host-subnav.tsx',
	'components/reservations/date-stepper.tsx',
	'components/reservations/shell-context.tsx',
	'components/reservations/reservations-chrome.tsx',
	'utils/reservations/shell-routes.ts',
	'routes/_app+/$orgSlug_+/reservations+/_layout.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.tsx',
	'components/reservations/policies/policies-screen.tsx',
	'components/reservations/policies/policy-sheet.tsx',
	'components/reservations/experiences/experiences-screen.tsx',
	'components/reservations/experiences/experience-create-sheet.tsx',
	'components/reservations/experiences/experience-editor.tsx',
	'components/reservations/experiences/schedule-sheet.tsx',
	'components/reservations/floor-plan-canvas.tsx',
	'components/reservations/floor-plan-editor/editor-fields.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.floor-plan.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.policies.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.tables.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.sections.tsx',
	'components/reservations/settings/setup-list-chrome.tsx',
	'components/reservations/messages/message-settings.tsx',
	'components/reservations/messages/message-preview.tsx',
	'routes/_app+/$orgSlug_+/reservations+/settings.special-days.tsx',
	'routes/_app+/$orgSlug_+/reservations+/experiences.tsx',
	'routes/_app+/$orgSlug_+/reservations+/experiences.$id.tsx',
	'components/reservations/status-style.tsx',
	'components/reservations/floor-table.tsx',
	'components/reservations/today-party-card.tsx',
	'components/reservations/use-host-stand.ts',
	'components/reservations/use-host-transitions.ts',
	'components/reservations/waitlist/today-waitlist-card.tsx',
	'components/dashboard/blocks/bookings-today-block.tsx',
	'hooks/use-reservations-poll.ts',
	'utils/reservations/floor-state.ts',
	'utils/reservations/host-actions.ts',
	'utils/reservations/host-errors.ts',
	'routes/_app+/$orgSlug_+/reservations+/today.tsx',
	'routes/_app+/$orgSlug_+/reservations+/floor.tsx',
	'routes/_app+/$orgSlug_+/reservations+/timeline.tsx',
	'routes/_app+/$orgSlug_+/reservations+/calendar.tsx',
	'routes/_app+/$orgSlug_+/reservations+/overview.tsx',
	'routes/_app+/$orgSlug_+/reservations+/book.tsx',
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
		it(`${file}: no native select, checkbox or table`, () => {
			expect(source).not.toMatch(/<select\b|<table\b|type="checkbox"/)
		})
		it(`${file}: no hard-coded locale`, () => {
			expect(source).not.toMatch(/en-GB|en-US/)
		})
	}
})
