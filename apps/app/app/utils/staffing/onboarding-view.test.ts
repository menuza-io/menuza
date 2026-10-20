import { type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
	type OnboardingTask,
	type StaffCertificate,
} from './onboarding-types.ts'
import {
	certificateFormToInput,
	checklistProgress,
	draftToInput,
	dueLabel,
	emptyDraftTask,
	formatDay,
	hasDraftErrors,
	localToday,
	rosterOnboarding,
	sortCertificates,
	taskFormToInput,
	templateToDraft,
	validateCertificateForm,
	validateDraft,
	validateTaskForm,
} from './onboarding-view.ts'

// The message id is the English source text, which is all these tests need.
const translate = (descriptor: MessageDescriptor) =>
	(descriptor.message ?? descriptor.id) as string

const task = (over: Partial<OnboardingTask> = {}): OnboardingTask => ({
	id: 't1',
	staffId: 's1',
	taskKey: null,
	title: 'Task',
	type: 'custom',
	instructions: null,
	linkUrl: null,
	assignee: 'manager',
	assigneeUserId: null,
	templateId: null,
	status: 'todo',
	dueDate: null,
	sortOrder: 0,
	source: 'manual',
	completedAt: null,
	completedBy: null,
	createdAt: 0,
	...over,
})

const cert = (over: Partial<StaffCertificate> = {}): StaffCertificate => ({
	id: 'c1',
	staffId: 's1',
	kind: 'food_handler',
	label: null,
	issuedOn: null,
	expiresOn: null,
	note: null,
	createdAt: 0,
	updatedAt: 0,
	...over,
})

describe('dates', () => {
	it('reads the device calendar day', () => {
		expect(localToday(new Date(2026, 9, 5, 23, 59).getTime())).toBe(
			'2026-10-05',
		)
		expect(localToday(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01')
	})

	it('formats a calendar day without drifting across time zones', () => {
		expect(formatDay('2026-10-14', 'en', { dateStyle: 'long' })).toBe(
			'October 14, 2026',
		)
		expect(formatDay('2026-01-01', 'en', { dateStyle: 'long' })).toBe(
			'January 1, 2026',
		)
		expect(formatDay('2026-10-14', 'ar')).toMatch(/١٤|14/)
	})
})

describe('checklist progress', () => {
	const today = '2026-10-14'

	it('counts done and skipped as complete and late tasks as overdue', () => {
		const progress = checklistProgress(
			[
				task({ status: 'done' }),
				task({ status: 'skipped' }),
				task({ dueDate: '2026-10-10' }),
				task({ dueDate: '2026-10-20' }),
			],
			today,
		)
		expect(progress).toEqual({ total: 4, complete: 2, overdue: 1, percent: 50 })
	})

	it('is zero for an empty list', () => {
		expect(checklistProgress([], today)).toEqual({
			total: 0,
			complete: 0,
			overdue: 0,
			percent: 0,
		})
	})

	it('does not call a finished task overdue', () => {
		expect(
			checklistProgress(
				[task({ status: 'done', dueDate: '2020-01-01' })],
				today,
			).overdue,
		).toBe(0)
	})
})

describe('roster badge', () => {
	const today = '2026-10-14'
	const entry = (over: Record<string, unknown> = {}) => ({
		staffId: 's1',
		total: 5,
		complete: 2,
		nextDueDate: '2026-10-20' as string | null,
		...over,
	})

	it('shows nothing without a checklist, or with a finished one', () => {
		expect(rosterOnboarding(undefined, today)).toEqual({ kind: 'none' })
		expect(rosterOnboarding(entry({ total: 0, complete: 0 }), today)).toEqual({
			kind: 'none',
		})
		expect(rosterOnboarding(entry({ complete: 5 }), today)).toEqual({
			kind: 'none',
		})
	})

	it('shows progress, and late when the earliest open task is past due', () => {
		expect(rosterOnboarding(entry(), today)).toEqual({
			kind: 'open',
			complete: 2,
			total: 5,
			overdue: false,
		})
		expect(
			rosterOnboarding(entry({ nextDueDate: '2026-10-13' }), today),
		).toMatchObject({ overdue: true })
		// Due today is not late yet.
		expect(
			rosterOnboarding(entry({ nextDueDate: '2026-10-14' }), today),
		).toMatchObject({ overdue: false })
		expect(rosterOnboarding(entry({ nextDueDate: null }), today)).toMatchObject(
			{ overdue: false },
		)
	})
})

describe('due labels', () => {
	const today = '2026-10-14'
	it('gives the state and the distance in days', () => {
		expect(dueLabel(task({ dueDate: '2026-10-11' }), today)).toEqual({
			state: 'overdue',
			days: -3,
		})
		expect(dueLabel(task({ dueDate: today }), today)).toEqual({
			state: 'due_today',
			days: 0,
		})
		expect(dueLabel(task({ dueDate: '2026-11-01' }), today)).toEqual({
			state: 'upcoming',
			days: 18,
		})
		expect(dueLabel(task(), today)).toEqual({ state: 'no_date', days: null })
		expect(
			dueLabel(task({ status: 'done', dueDate: '2020-01-01' }), today),
		).toMatchObject({ state: 'done' })
	})
})

describe('certificate order', () => {
	it('puts expired first, then soonest to expire, then the rest', () => {
		const today = '2026-10-14'
		const sorted = sortCertificates(
			[
				cert({ id: 'none' }),
				cert({ id: 'far', expiresOn: '2027-06-01' }),
				cert({ id: 'soon', expiresOn: '2026-10-30' }),
				cert({ id: 'gone', expiresOn: '2026-09-01' }),
				cert({ id: 'near', expiresOn: '2026-10-20' }),
			],
			today,
		)
		expect(sorted.map((c) => c.id)).toEqual([
			'gone',
			'near',
			'soon',
			'far',
			'none',
		])
	})

	it('does not change the list it was given', () => {
		const list = [cert({ id: 'b', expiresOn: '2027-01-01' }), cert({ id: 'a' })]
		sortCertificates(list, '2026-10-14')
		expect(list.map((c) => c.id)).toEqual(['b', 'a'])
	})
})

describe('template draft', () => {
	const draft = () => ({
		name: 'Floor',
		isDefault: false,
		tasks: [emptyDraftTask({ title: 'Meet the chef' })],
	})

	it('accepts a plain draft and turns it into the request body', () => {
		const value = draft()
		expect(hasDraftErrors(validateDraft(value, translate))).toBe(false)
		expect(draftToInput(value)).toEqual({
			name: 'Floor',
			isDefault: false,
			tasks: [
				{
					type: 'custom',
					title: 'Meet the chef',
					instructions: null,
					linkUrl: null,
					dueInDays: 3,
					assignee: 'manager',
					assigneeUserId: null,
				},
			],
		})
	})

	it('names every problem next to the task it belongs to', () => {
		const first = emptyDraftTask({ title: '' })
		const second = emptyDraftTask({
			type: 'form_link',
			title: 'Form',
			linkUrl: 'http://insecure.example.com',
			dueInDays: '91',
		})
		const third = emptyDraftTask({
			type: 'acknowledge_policy',
			title: 'Policy',
		})
		const errors = validateDraft(
			{ name: ' ', isDefault: false, tasks: [first, second, third] },
			translate,
		)
		expect(errors.name).toBeTruthy()
		expect(errors.task[first.key]?.title).toBeTruthy()
		expect(errors.task[second.key]?.linkUrl).toMatch(/https/)
		expect(errors.task[second.key]?.dueInDays).toBeTruthy()
		expect(errors.task[third.key]?.instructions).toBeTruthy()
		expect(hasDraftErrors(errors)).toBe(true)
	})

	it('refuses an empty list, fractional or negative days and markup', () => {
		expect(
			validateDraft({ name: 'x', isDefault: false, tasks: [] }, translate)
				.tasks,
		).toBeTruthy()
		for (const dueInDays of ['-1', '1.5', '', 'abc']) {
			const t = emptyDraftTask({ title: 'x', dueInDays })
			expect(
				validateDraft({ name: 'x', isDefault: false, tasks: [t] }, translate)
					.task[t.key]?.dueInDays,
			).toBeTruthy()
		}
		const markup = emptyDraftTask({ title: '<b>x</b>' })
		expect(
			validateDraft({ name: 'x', isDefault: false, tasks: [markup] }, translate)
				.task[markup.key]?.title,
		).toBeTruthy()
	})

	it('sends a link only for form tasks', () => {
		const t = emptyDraftTask({
			type: 'custom',
			title: 'x',
			linkUrl: 'https://left-over.example.com',
		})
		expect(
			draftToInput({ name: 'x', isDefault: false, tasks: [t] }).tasks[0]!
				.linkUrl,
		).toBeNull()
	})

	it('keeps a member assignment through an edit and save', () => {
		const loaded = templateToDraft({
			name: 'A',
			isDefault: true,
			tasks: [
				{
					type: 'custom',
					title: 'X',
					instructions: null,
					linkUrl: null,
					dueInDays: 2,
					assignee: 'member',
					assigneeUserId: 'user_9',
				},
			],
		})
		const body = draftToInput(loaded)
		expect(body.isDefault).toBe(true)
		expect(body.tasks[0]).toMatchObject({
			assignee: 'member',
			assigneeUserId: 'user_9',
			dueInDays: 2,
		})
	})

	it('gives every draft task its own key', () => {
		const a = emptyDraftTask()
		const b = emptyDraftTask()
		expect(a.key).not.toBe(b.key)
	})
})

describe('one-off task form', () => {
	const base = {
		type: 'custom' as const,
		title: 'Order uniform',
		instructions: '',
		linkUrl: '',
		dueDate: '',
		assignee: 'manager' as const,
	}

	it('accepts a title alone and builds the body', () => {
		expect(validateTaskForm(base, translate)).toEqual({})
		expect(taskFormToInput(base)).toEqual({
			type: 'custom',
			title: 'Order uniform',
			instructions: null,
			linkUrl: null,
			dueDate: null,
			assignee: 'manager',
			assigneeUserId: null,
		})
	})

	it('needs a safe link for a form and policy text for a policy', () => {
		expect(
			validateTaskForm({ ...base, type: 'form_link' }, translate).linkUrl,
		).toBeTruthy()
		for (const linkUrl of [
			'javascript:alert(1)',
			'http://a.example.com',
			'https://user:pw@a.example.com',
		]) {
			expect(
				validateTaskForm({ ...base, type: 'form_link', linkUrl }, translate)
					.linkUrl,
			).toBeTruthy()
		}
		expect(
			validateTaskForm(
				{ ...base, type: 'form_link', linkUrl: 'https://f.example.com/x' },
				translate,
			),
		).toEqual({})
		expect(
			validateTaskForm({ ...base, type: 'acknowledge_policy' }, translate)
				.instructions,
		).toBeTruthy()
	})

	it('does not send a link left behind after switching away from a form task', () => {
		expect(
			taskFormToInput({
				...base,
				type: 'custom',
				linkUrl: 'https://f.example.com',
			}).linkUrl,
		).toBeNull()
	})
})

describe('certificate form', () => {
	const base = {
		kind: 'food_handler' as const,
		label: '',
		issuedOn: '',
		expiresOn: '',
		note: '',
	}

	it('needs a name for other, orders the dates and trims', () => {
		expect(validateCertificateForm(base, translate)).toEqual({})
		expect(
			validateCertificateForm({ ...base, kind: 'other' }, translate).label,
		).toBeTruthy()
		expect(
			validateCertificateForm(
				{ ...base, issuedOn: '2026-05-02', expiresOn: '2026-05-01' },
				translate,
			).expiresOn,
		).toBeTruthy()
		expect(
			certificateFormToInput({
				...base,
				kind: 'other',
				label: '  Barista  ',
				expiresOn: '2027-01-01',
			}),
		).toEqual({
			kind: 'other',
			label: 'Barista',
			issuedOn: null,
			expiresOn: '2027-01-01',
			note: null,
		})
	})

	it('refuses markup in the label and note', () => {
		const errors = validateCertificateForm(
			{ ...base, kind: 'other', label: '<x>', note: '<img>' },
			translate,
		)
		expect(errors.label).toBeTruthy()
		expect(errors.note).toBeTruthy()
	})
})
