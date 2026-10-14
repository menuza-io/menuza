import { describe, expect, it } from 'vitest'
import {
	certificateAlertStage,
	certificateInputSchema,
	certificateStanding,
	certificateUpdateSchema,
	dueDateFrom,
	moveItem,
	onboardingApplySchema,
	onboardingProgress,
	onboardingTaskCreateSchema,
	onboardingTaskUpdateSchema,
	onboardingTemplateInputSchema,
	ONBOARDING_LIMITS,
	parseFormLink,
	taskDueState,
	taskReminderStage,
} from './onboarding-api.ts'

const task = (over: Record<string, unknown> = {}) => ({
	type: 'custom',
	title: 'Hand in the signed rota',
	dueInDays: 3,
	...over,
})

describe('form links', () => {
	it('accepts https links and normalizes them', () => {
		expect(parseFormLink('https://forms.example.com/start')).toBe(
			'https://forms.example.com/start',
		)
	})

	it.each([
		'http://forms.example.com',
		'javascript:alert(1)',
		'data:text/html,<script>1</script>',
		'ftp://forms.example.com',
		'https://user:pass@forms.example.com',
		'https://localhost',
		'//forms.example.com',
		'not a url',
		'',
		`https://example.com/${'a'.repeat(ONBOARDING_LIMITS.linkUrl)}`,
	])('refuses %s', (value) => {
		expect(parseFormLink(value)).toBeNull()
	})
})

describe('template schema', () => {
	const base = { name: 'Day-one start', tasks: [task()] }

	it('accepts a minimal template and defaults the optional fields', () => {
		const parsed = onboardingTemplateInputSchema.parse(base)
		expect(parsed.isDefault).toBe(false)
		expect(parsed.tasks[0]).toMatchObject({
			assignee: 'manager',
			assigneeUserId: null,
			instructions: null,
			linkUrl: null,
		})
	})

	it('needs at least one task and no more than the limit', () => {
		expect(
			onboardingTemplateInputSchema.safeParse({ ...base, tasks: [] }).success,
		).toBe(false)
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: Array.from(
					{ length: ONBOARDING_LIMITS.tasksPerTemplate + 1 },
					() => task(),
				),
			}).success,
		).toBe(false)
	})

	it('refuses unknown keys, including anything shaped like a tax or id field', () => {
		for (const extra of [
			{ ssn: '123-45-6789' },
			{ nationalId: '1' },
			{ iban: 'SA00' },
			{ taxForm: 'w4' },
			{ uploadUrl: 'https://example.com' },
		]) {
			expect(
				onboardingTemplateInputSchema.safeParse({
					...base,
					tasks: [task(extra)],
				}).success,
			).toBe(false)
		}
		expect(
			onboardingTemplateInputSchema.safeParse({ ...base, ssn: '1' }).success,
		).toBe(false)
	})

	it('does not offer document upload as a task type', () => {
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [task({ type: 'upload_document' })],
			}).success,
		).toBe(false)
	})

	it('requires a link for form tasks and refuses one elsewhere', () => {
		const missing = onboardingTemplateInputSchema.safeParse({
			...base,
			tasks: [task({ type: 'form_link' })],
		})
		expect(missing.success).toBe(false)
		const ok = onboardingTemplateInputSchema.safeParse({
			...base,
			tasks: [task({ type: 'form_link', linkUrl: 'https://f.example.com/a' })],
		})
		expect(ok.success).toBe(true)
		const stray = onboardingTemplateInputSchema.safeParse({
			...base,
			tasks: [task({ linkUrl: 'https://f.example.com/a' })],
		})
		expect(stray.success).toBe(false)
		const unsafe = onboardingTemplateInputSchema.safeParse({
			...base,
			tasks: [task({ type: 'form_link', linkUrl: 'javascript:alert(1)' })],
		})
		expect(unsafe.success).toBe(false)
	})

	it('requires policy text to acknowledge', () => {
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [task({ type: 'acknowledge_policy' })],
			}).success,
		).toBe(false)
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [
					task({
						type: 'acknowledge_policy',
						instructions: 'Wash hands.\nWear a hat.',
					}),
				],
			}).success,
		).toBe(true)
	})

	it('ties the member id to the member assignee', () => {
		const withMember = (extra: Record<string, unknown>) =>
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [task(extra)],
			}).success
		expect(withMember({ assignee: 'member' })).toBe(false)
		expect(withMember({ assignee: 'member', assigneeUserId: 'user_1' })).toBe(
			true,
		)
		expect(withMember({ assignee: 'manager', assigneeUserId: 'user_1' })).toBe(
			false,
		)
		expect(withMember({ assignee: 'staff' })).toBe(true)
	})

	it('keeps markup and control characters out of text', () => {
		for (const title of ['<b>x</b>', 'a\u0000b', '   ']) {
			expect(
				onboardingTemplateInputSchema.safeParse({
					...base,
					tasks: [task({ title })],
				}).success,
			).toBe(false)
		}
		expect(
			onboardingTemplateInputSchema.safeParse({
				name: '<script>',
				tasks: [task()],
			}).success,
		).toBe(false)
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [
					task({
						type: 'acknowledge_policy',
						instructions: 'Line one\n<img src=x>',
					}),
				],
			}).success,
		).toBe(false)
	})

	it('bounds the due offset', () => {
		for (const dueInDays of [-1, 1.5, ONBOARDING_LIMITS.maxDueInDays + 1]) {
			expect(
				onboardingTemplateInputSchema.safeParse({
					...base,
					tasks: [task({ dueInDays })],
				}).success,
			).toBe(false)
		}
		expect(
			onboardingTemplateInputSchema.safeParse({
				...base,
				tasks: [task({ dueInDays: 0 })],
			}).success,
		).toBe(true)
	})
})

describe('task schemas', () => {
	it('creates a one-off task with an optional real date', () => {
		expect(
			onboardingTaskCreateSchema.safeParse({
				type: 'custom',
				title: 'Order uniform',
				dueDate: '2026-02-30',
			}).success,
		).toBe(false)
		const parsed = onboardingTaskCreateSchema.parse({
			type: 'custom',
			title: 'Order uniform',
		})
		expect(parsed.dueDate).toBeNull()
	})

	it('needs at least one field to update and refuses strangers', () => {
		expect(onboardingTaskUpdateSchema.safeParse({}).success).toBe(false)
		expect(
			onboardingTaskUpdateSchema.safeParse({ status: 'done' }).success,
		).toBe(true)
		expect(
			onboardingTaskUpdateSchema.safeParse({ status: 'archived' }).success,
		).toBe(false)
		expect(
			onboardingTaskUpdateSchema.safeParse({ status: 'done', staffId: 'x' })
				.success,
		).toBe(false)
		expect(
			onboardingTaskUpdateSchema.safeParse({ linkUrl: 'http://a.example.com' })
				.success,
		).toBe(false)
	})

	it('applies a template with an optional id and base date', () => {
		expect(onboardingApplySchema.safeParse({}).success).toBe(true)
		expect(
			onboardingApplySchema.safeParse({ baseDate: '2026-13-01' }).success,
		).toBe(false)
		expect(onboardingApplySchema.safeParse({ extra: 1 }).success).toBe(false)
	})
})

describe('certificate schemas', () => {
	it('needs a label for other and orders the dates', () => {
		expect(certificateInputSchema.safeParse({ kind: 'other' }).success).toBe(
			false,
		)
		expect(
			certificateInputSchema.safeParse({ kind: 'other', label: 'Specialist' })
				.success,
		).toBe(true)
		expect(
			certificateInputSchema.safeParse({
				kind: 'food_handler',
				issuedOn: '2026-05-01',
				expiresOn: '2026-04-30',
			}).success,
		).toBe(false)
		expect(
			certificateInputSchema.safeParse({
				kind: 'food_handler',
				issuedOn: '2026-05-01',
				expiresOn: '2026-05-01',
			}).success,
		).toBe(true)
	})

	it('carries no number or document field', () => {
		for (const extra of [
			{ number: '123' },
			{ fileUrl: 'https://a.example.com' },
		]) {
			expect(
				certificateInputSchema.safeParse({ kind: 'food_handler', ...extra })
					.success,
			).toBe(false)
		}
		expect(certificateUpdateSchema.safeParse({}).success).toBe(false)
		expect(certificateUpdateSchema.safeParse({ expiresOn: null }).success).toBe(
			true,
		)
	})
})

describe('due state and progress', () => {
	const today = '2026-10-14'

	it('classifies a task against today', () => {
		expect(taskDueState({ status: 'done', dueDate: null }, today)).toBe('done')
		expect(
			taskDueState({ status: 'skipped', dueDate: '2020-01-01' }, today),
		).toBe('skipped')
		expect(taskDueState({ status: 'todo', dueDate: null }, today)).toBe(
			'no_date',
		)
		expect(taskDueState({ status: 'todo', dueDate: '2026-10-13' }, today)).toBe(
			'overdue',
		)
		expect(taskDueState({ status: 'todo', dueDate: today }, today)).toBe(
			'due_today',
		)
		expect(taskDueState({ status: 'todo', dueDate: '2026-10-15' }, today)).toBe(
			'upcoming',
		)
	})

	it('counts done and skipped as complete and reports overdue', () => {
		expect(onboardingProgress([], today)).toEqual({
			total: 0,
			complete: 0,
			overdue: 0,
			percent: 0,
			state: 'none',
		})
		expect(
			onboardingProgress(
				[
					{ status: 'todo', dueDate: '2026-10-20' },
					{ status: 'todo', dueDate: '2026-10-01' },
				],
				today,
			),
		).toMatchObject({ state: 'not_started', overdue: 1, percent: 0 })
		expect(
			onboardingProgress(
				[
					{ status: 'done', dueDate: null },
					{ status: 'skipped', dueDate: null },
					{ status: 'todo', dueDate: null },
				],
				today,
			),
		).toMatchObject({ state: 'in_progress', complete: 2, percent: 67 })
		expect(
			onboardingProgress(
				[
					{ status: 'done', dueDate: null },
					{ status: 'skipped', dueDate: null },
				],
				today,
			),
		).toMatchObject({ state: 'complete', percent: 100 })
	})

	it('a checklist that is only skipped is not "in progress"', () => {
		expect(
			onboardingProgress([{ status: 'skipped', dueDate: null }], today).state,
		).toBe('complete')
	})
})

describe('reminder stages', () => {
	const today = '2026-10-14'
	const open = (dueDate: string | null) => ({
		status: 'todo' as const,
		dueDate,
	})

	it('reminds when due, then again once overdue for three days', () => {
		expect(taskReminderStage(open('2026-10-15'), today)).toBe(0)
		expect(taskReminderStage(open('2026-10-14'), today)).toBe(1)
		expect(taskReminderStage(open('2026-10-12'), today)).toBe(1)
		expect(taskReminderStage(open('2026-10-11'), today)).toBe(2)
		expect(taskReminderStage(open('2026-01-01'), today)).toBe(2)
	})

	it('never reminds about finished, skipped or undated tasks', () => {
		expect(
			taskReminderStage({ status: 'done', dueDate: '2026-01-01' }, today),
		).toBe(0)
		expect(
			taskReminderStage({ status: 'skipped', dueDate: '2026-01-01' }, today),
		).toBe(0)
		expect(taskReminderStage(open(null), today)).toBe(0)
	})
})

describe('certificate standing', () => {
	const today = '2026-10-14'

	it('is valid through the expiry day and expired the day after', () => {
		expect(certificateStanding('2026-10-14', today)).toEqual({
			status: 'expiring',
			daysLeft: 0,
		})
		expect(certificateStanding('2026-10-13', today)).toEqual({
			status: 'expired',
			daysLeft: -1,
		})
	})

	it('warns for the last thirty days only', () => {
		expect(certificateStanding('2026-11-13', today).status).toBe('expiring')
		expect(certificateStanding('2026-11-14', today).status).toBe('valid')
		expect(certificateStanding(null, today)).toEqual({
			status: 'no_expiry',
			daysLeft: null,
		})
	})

	it('maps standing to an alert stage', () => {
		expect(certificateAlertStage(null, today)).toBe(0)
		expect(certificateAlertStage('2027-01-01', today)).toBe(0)
		expect(certificateAlertStage('2026-10-30', today)).toBe(1)
		expect(certificateAlertStage('2026-10-13', today)).toBe(2)
	})

	it('handles month and year ends and leap days', () => {
		expect(certificateStanding('2028-02-29', '2028-02-28').daysLeft).toBe(1)
		expect(certificateStanding('2027-01-05', '2026-12-31').daysLeft).toBe(5)
	})
})

describe('helpers', () => {
	it('counts due dates in calendar days', () => {
		expect(dueDateFrom('2026-10-30', 3)).toBe('2026-11-02')
		expect(dueDateFrom('2026-12-30', 7)).toBe('2027-01-06')
	})

	it('moves items without mutating and ignores out-of-range moves', () => {
		const list = ['a', 'b', 'c']
		expect(moveItem(list, 1, -1)).toEqual(['b', 'a', 'c'])
		expect(moveItem(list, 1, 1)).toEqual(['a', 'c', 'b'])
		expect(moveItem(list, 0, -1)).toEqual(list)
		expect(moveItem(list, 2, 1)).toEqual(list)
		expect(moveItem(list, 5, -1)).toEqual(list)
		expect(list).toEqual(['a', 'b', 'c'])
	})
})
