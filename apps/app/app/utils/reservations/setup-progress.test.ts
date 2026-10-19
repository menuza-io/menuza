import { describe, expect, it } from 'vitest'
import {
	deriveSetupSteps,
	describeSetupIssues,
	formatPartySizeRanges,
	setupProgress,
	summarizeSetupStatus,
} from './setup-progress.ts'

const base = {
	serviceCount: 2,
	tableCount: 5,
	enabledMessageCount: 3,
	settingsVersion: 2,
	rulesReviewed: false,
	bookingTested: false,
	issues: [],
}

describe('deriveSetupSteps', () => {
	it('marks the first incomplete step as next', () => {
		const steps = deriveSetupSteps({ ...base, tableCount: 0 })
		expect(steps.map((s) => s.status)).toEqual([
			'done',
			'todo',
			'done',
			'done',
			'todo',
		])
		expect(steps.find((s) => s.next)?.id).toBe('tables')
		expect(setupProgress(steps)).toMatchObject({ done: 3, total: 5 })
	})
	it('is unknown (loading) while inputs are missing', () => {
		const steps = deriveSetupSteps({ ...base, serviceCount: null })
		expect(steps[0]!.status).toBe('unknown')
		expect(setupProgress(steps).loading).toBe(true)
	})
	it('completes when every step is done', () => {
		const steps = deriveSetupSteps({ ...base, bookingTested: true })
		expect(setupProgress(steps).complete).toBe(true)
	})
	it('does not count services with a blocking services issue', () => {
		const steps = deriveSetupSteps({
			...base,
			issues: [{ code: 'service_invalid_window', severity: 'error' }],
		})
		expect(steps[0]!.status).toBe('todo')
	})
	it('treats rules as done after a save or a review', () => {
		expect(deriveSetupSteps({ ...base, settingsVersion: 1 })[2]!.status).toBe(
			'todo',
		)
		expect(
			deriveSetupSteps({ ...base, settingsVersion: 1, rulesReviewed: true })[2]!
				.status,
		).toBe('done')
	})
})

describe('summarizeSetupStatus', () => {
	it('is ready with no issues', () => {
		expect(summarizeSetupStatus([]).state).toBe('ready')
	})
	it('is ready with suggestions for warnings only', () => {
		const s = summarizeSetupStatus([{ severity: 'warning' }])
		expect(s).toMatchObject({ state: 'ready_suggestions', suggestionCount: 1 })
	})
	it('needs attention for errors and for an empty setup', () => {
		expect(summarizeSetupStatus([{ severity: 'error' }]).state).toBe(
			'needs_attention',
		)
		expect(summarizeSetupStatus([], { noTables: true })).toMatchObject({
			state: 'needs_attention',
			blockingCount: 1,
		})
	})
})

describe('describeSetupIssues', () => {
	it('folds unseatable party sizes into ranges and sorts blocking first', () => {
		const items = describeSetupIssues([
			{ code: 'unseatable_party_size', severity: 'warning', partySize: 7 },
			{ code: 'unseatable_party_size', severity: 'warning', partySize: 8 },
			{ code: 'duplicate_table_label', severity: 'error' },
		])
		expect(items).toHaveLength(2)
		expect(items[0]!.severity).toBe('error')
		expect(items[0]!.tab).toBe('tables')
		expect(items[1]!.text.values).toMatchObject({ ranges: '7-8' })
	})
	it('names the service and links to services', () => {
		const items = describeSetupIssues(
			[{ code: 'service_invalid_window', severity: 'error', serviceId: 's1' }],
			new Map([['s1', 'Weekend Brunch']]),
		)
		expect(items[0]!.text.values).toMatchObject({ named: 'Weekend Brunch' })
		expect(items[0]!.tab).toBe('services')
	})
	it('adds fixable rows for an empty setup', () => {
		const items = describeSetupIssues([], new Map(), {
			noServices: true,
			noTables: true,
		})
		expect(items.map((i) => i.tab)).toEqual(['services', 'tables'])
	})
})

describe('formatPartySizeRanges', () => {
	it('collapses consecutive sizes', () => {
		expect(formatPartySizeRanges([1, 2, 3, 5, 6, 9])).toBe('1-3, 5-6, 9')
	})
})
