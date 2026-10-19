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
	'components/reservations/waitlist/waitlist-screen.tsx',
	'components/reservations/waitlist/waitlist-queue.tsx',
	'components/reservations/waitlist/floor-waitlist-panel.tsx',
	'components/reservations/waitlist/add-party-dialog.tsx',
	'components/reservations/waitlist/edit-party-dialog.tsx',
	'components/reservations/waitlist/seat-dialog.tsx',
	'components/reservations/waitlist/party-fields.tsx',
	'components/reservations/waitlist/waitlist-clock.tsx',
	'components/reservations/guests/guest-list-screen.tsx',
	'components/reservations/guests/guest-profile-screen.tsx',
	'components/reservations/guests/guest-notes-panel.tsx',
	'components/reservations/guests/guest-merge-dialog.tsx',
	'components/reservations/guests/guest-tag-badge.tsx',
	'components/reservations/guest-profile-card.tsx',
	'components/reservations/reports/reports-screen.tsx',
	'components/reservations/reports/report-panels.tsx',
	'utils/reservations/reports-export.ts',
	'utils/reservations/setup-issue-target.ts',
	'routes/_app+/$orgSlug_+/reservations+/waitlist.tsx',
	'routes/_app+/$orgSlug_+/reservations+/guests.tsx',
	'routes/_app+/$orgSlug_+/reservations+/guests.$guestId.tsx',
	'routes/_app+/$orgSlug_+/reservations+/reports.tsx',
]

/** Sheets and dialogs: no native form controls or buttons either. */
const SHEET_FILES = [
	'components/reservations/booking-sheet.tsx',
	'components/reservations/detail-sheet.tsx',
	'components/reservations/walk-in-dialog.tsx',
	'components/reservations/conflict-panel.tsx',
	'components/reservations/requests-panel.tsx',
	'components/reservations/sheet-parts.tsx',
	'components/reservations/guest-profile-card.tsx',
	'components/reservations/channel-badge.tsx',
	'components/reservations/payment-badge.tsx',
]

const RAW_COLOR =
	/\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:emerald|amber|slate|sky|blue|red|orange|yellow|gray|zinc|green)-\d/
const HEX = /\[#[0-9a-fA-F]{3,8}\]/
const TINY_TEXT = /text-\[1\d?px\]/
const PHYSICAL =
	/(?:^|[\s"'`:])-?(?:ml|mr|pl|pr)-(?:\d|px|auto)|text-(?:left|right)\b|(?:^|[\s"'`:])(?:left|right)-\d|rounded-(?:l|r|tl|tr|bl|br)-|border-(?:l|r)(?:-|\b)/m

describe('reservation sheets and dialogs follow the design conventions', () => {
	for (const file of SHEET_FILES) {
		const source = fs.readFileSync(path.join(APP, file), 'utf8')
		it(`${file}: tokens only, logical direction, no tiny text`, () => {
			expect(source).not.toMatch(RAW_COLOR)
			expect(source).not.toMatch(HEX)
			expect(source).not.toMatch(TINY_TEXT)
			expect(source).not.toMatch(PHYSICAL)
		})
		it(`${file}: no native select, checkbox, table, input, textarea or button`, () => {
			expect(source).not.toMatch(
				/<select\b|<table\b|<input\b|<textarea\b|<button\b|type="checkbox"/,
			)
		})
		it(`${file}: no hard-coded locale`, () => {
			expect(source).not.toMatch(/en-GB|en-US/)
		})
	}
	for (const file of SHEET_FILES.filter((f) => /sheet|dialog|panel/.test(f))) {
		const source = fs.readFileSync(path.join(APP, file), 'utf8')
		it(`${file}: no version internals shown to users`, () => {
			expect(source).not.toMatch(/>\s*v\{[^}]*(version|Version)/)
		})
	}
})

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

/** Screens that live under the layout header: they put actions in the header slot, never their own page header. */
const HEADERLESS_SCREENS = [
	'components/reservations/waitlist/waitlist-screen.tsx',
	'components/reservations/guests/guest-list-screen.tsx',
	'components/reservations/reports/reports-screen.tsx',
	'components/reservations/experiences/experiences-screen.tsx',
]

describe('section screens sit under the layout header', () => {
	for (const file of HEADERLESS_SCREENS) {
		const source = fs.readFileSync(path.join(APP, file), 'utf8')
		it(`${file}: no PageHeader of its own, actions go through the header slot`, () => {
			expect(source).not.toMatch(/PageHeader/)
			expect(source).toMatch(/ReservationsHeaderActions|WorkspaceToolbar/)
		})
	}
})

/** Native controls the shared primitives replace, in the screens this milestone polished. */
const NO_NATIVE_CONTROLS = [
	'components/reservations/waitlist/waitlist-screen.tsx',
	'components/reservations/waitlist/waitlist-queue.tsx',
	'components/reservations/waitlist/add-party-dialog.tsx',
	'components/reservations/waitlist/edit-party-dialog.tsx',
	'components/reservations/waitlist/seat-dialog.tsx',
	'components/reservations/waitlist/party-fields.tsx',
	'components/reservations/guests/guest-list-screen.tsx',
	'components/reservations/guests/guest-profile-screen.tsx',
	'components/reservations/guests/guest-notes-panel.tsx',
	'components/reservations/guests/guest-merge-dialog.tsx',
	'components/reservations/guest-profile-card.tsx',
	'components/reservations/reports/reports-screen.tsx',
	'components/reservations/reports/report-panels.tsx',
]

describe('polished screens use the shared controls', () => {
	for (const file of NO_NATIVE_CONTROLS) {
		const source = fs.readFileSync(path.join(APP, file), 'utf8')
		it(`${file}: no native button, input, textarea or select`, () => {
			expect(source).not.toMatch(/<(?:button|input|textarea|select)\b/)
		})
	}
})

describe('timeline sticky header', () => {
	const source = fs.readFileSync(
		path.join(APP, 'routes/_app+/$orgSlug_+/reservations+/timeline.tsx'),
		'utf8',
	)
	it('uses opaque backgrounds on the sticky header and table cells', () => {
		const sticky = source.match(/className="[^"]*\bsticky\b[^"]*"/g) ?? []
		expect(sticky.length).toBeGreaterThan(2)
		for (const cls of sticky) expect(cls).not.toMatch(/bg-[a-z]+\/\d+/)
	})
	it('stacks sticky cells above scrolled bars and the now line', () => {
		expect(source).toMatch(/sticky top-0 z-40/)
		expect(source).toMatch(
			/sticky start-0 z-30 flex w-48 shrink-0 items-center justify-between border-e px-3 py-2 text-xs"/,
		)
	})
})
