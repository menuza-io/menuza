import { describe, expect, it } from 'vitest'
import {
	type LaunchChecklist,
	type LaunchLocationView,
	type LaunchStepView,
} from './launch.ts'
import {
	nextReminderDue,
	pickReminderTarget,
	progressSignature,
} from './setup-reminders.ts'

const DAY = 86_400_000
const T0 = new Date('2027-02-01T03:00:00Z')
const at = (days: number) => new Date(T0.getTime() + days * DAY)

describe('nextReminderDue (#271)', () => {
	it('is due 1, 3 and 7 days after the last progress, one at a time', () => {
		const state = { progressAt: T0, lastAutoDay: 0 }
		expect(nextReminderDue({ ...state, now: at(0.9) })).toBeNull()
		expect(nextReminderDue({ ...state, now: at(1) })).toEqual({
			day: 1,
			send: true,
		})
		expect(
			nextReminderDue({ ...state, lastAutoDay: 1, now: at(2.9) }),
		).toBeNull()
		expect(nextReminderDue({ ...state, lastAutoDay: 1, now: at(3) })).toEqual({
			day: 3,
			send: true,
		})
		expect(nextReminderDue({ ...state, lastAutoDay: 3, now: at(7) })).toEqual({
			day: 7,
			send: true,
		})
	})

	it('stops after the third reminder', () => {
		for (const days of [7, 8, 30, 365]) {
			expect(
				nextReminderDue({ progressAt: T0, lastAutoDay: 7, now: at(days) }),
			).toBeNull()
		}
	})

	it('sends only the latest day reached when the job missed some, never two at once', () => {
		expect(
			nextReminderDue({ progressAt: T0, lastAutoDay: 0, now: at(3.5) }),
		).toEqual({ day: 3, send: true })
	})

	it('marks a day that is more than three days late as skipped instead of sending it', () => {
		expect(
			nextReminderDue({ progressAt: T0, lastAutoDay: 0, now: at(5.9) }),
		).toEqual({ day: 3, send: true })
		expect(
			nextReminderDue({ progressAt: T0, lastAutoDay: 0, now: at(6) }),
		).toEqual({ day: 3, send: false })
		expect(
			nextReminderDue({ progressAt: T0, lastAutoDay: 0, now: at(30) }),
		).toEqual({ day: 7, send: false })
	})
})

function step(
	key: string,
	state: LaunchStepView['state'],
	optional = false,
): LaunchStepView {
	return {
		key,
		condition: 'locationHasHours',
		optional,
		organizationWide: false,
		state,
		href: `/${key}/:locationId`.replace(':locationId', 'loc_1'),
		completedAt: null,
		skippedAt: null,
		skipReason: null,
	}
}

function location(
	steps: LaunchStepView[],
	live = false,
	id = 'loc_1',
): LaunchLocationView {
	const required = steps.filter((entry) => !entry.optional)
	return {
		id,
		name: id,
		live,
		liveAt: null,
		steps,
		requiredDone: required.filter((entry) => entry.state === 'done').length,
		requiredTotal: required.length,
	}
}

const checklist = (locations: LaunchLocationView[]): LaunchChecklist => ({
	locations,
	siteUrl: 'https://x.test',
	guestsOffered: false,
})

describe('pickReminderTarget (#271)', () => {
	it('names the single next required step with progress, ignoring optional ones', () => {
		const target = pickReminderTarget(
			checklist([
				location([
					step('launch_location_details', 'done'),
					step('launch_station', 'optional', true),
					step('launch_menu', 'todo'),
					step('launch_branding', 'todo'),
				]),
			]),
		)
		expect(target).toMatchObject({
			kind: 'step',
			stepKey: 'launch_menu',
			done: 1,
			total: 3,
			doneKeys: ['launch_location_details'],
		})
	})

	it('falls back to going live when every required step is done but the location is not live', () => {
		const target = pickReminderTarget(
			checklist([
				location([
					step('launch_location_details', 'done'),
					step('launch_go_live', 'done'),
				]),
			]),
		)
		expect(target).toMatchObject({ kind: 'step', stepKey: 'launch_go_live' })
	})

	it('is live as soon as any location is live, and has nothing without locations', () => {
		expect(
			pickReminderTarget(
				checklist([
					location([step('launch_menu', 'todo')]),
					location([step('launch_menu', 'done')], true, 'loc_2'),
				]),
			),
		).toEqual({ kind: 'live' })
		expect(pickReminderTarget(checklist([]))).toEqual({ kind: 'none' })
		expect(pickReminderTarget(null)).toEqual({ kind: 'none' })
	})
})

describe('progressSignature', () => {
	it('changes with any done step and with the location, and ignores order', () => {
		const a = progressSignature({
			locationId: 'loc_1',
			doneKeys: ['launch_menu', 'launch_branding'],
		})
		expect(
			progressSignature({
				locationId: 'loc_1',
				doneKeys: ['launch_branding', 'launch_menu'],
			}),
		).toBe(a)
		expect(
			progressSignature({ locationId: 'loc_1', doneKeys: ['launch_menu'] }),
		).not.toBe(a)
		expect(
			progressSignature({
				locationId: 'loc_2',
				doneKeys: ['launch_menu', 'launch_branding'],
			}),
		).not.toBe(a)
	})
})
