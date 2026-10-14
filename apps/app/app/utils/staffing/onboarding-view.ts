import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	certificateStanding,
	ONBOARDING_LIMITS,
	parseFormLink,
	taskDueState,
	type CertificateStanding,
	type OnboardingAssignee,
	type OnboardingTaskType,
	type TaskDueState,
} from '@repo/staffing'
import {
	type OnboardingSummaryRow,
	type OnboardingTask,
	type StaffCertificate,
} from './onboarding-types.ts'

/**
 * Pure helpers for the onboarding screens: dates, progress, certificate
 * standing and the template draft. No React and no copy that needs a language
 * (labels live in the components, where Lingui can translate them).
 *
 * "Today" is the calendar day on the manager's device. A scope's own day can
 * differ for a manager who is somewhere else; the reminders the regional tick
 * sends use the scope's day, so this only affects what is shown as late.
 */

type Translate = (descriptor: MessageDescriptor) => string

export function localToday(now: number = Date.now()): string {
	const date = new Date(now)
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

/** `2026-10-14` as a short date in the viewer's language (no time zone drift). */
export function formatDay(
	date: string,
	locale: string,
	options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return new Intl.DateTimeFormat(locale, {
		...options,
		timeZone: 'UTC',
	}).format(Date.UTC(year, month - 1, day, 12))
}

export type ChecklistProgress = {
	total: number
	complete: number
	overdue: number
	percent: number
}

export function checklistProgress(
	tasks: readonly OnboardingTask[],
	today: string,
): ChecklistProgress {
	let complete = 0
	let overdue = 0
	for (const task of tasks) {
		const state = taskDueState(task, today)
		if (state === 'done' || state === 'skipped') complete++
		if (state === 'overdue') overdue++
	}
	const total = tasks.length
	return {
		total,
		complete,
		overdue,
		percent: total === 0 ? 0 : Math.round((complete / total) * 100),
	}
}

/**
 * What the roster shows for one person. Nothing for a finished or empty
 * checklist: the badge is for people who still have something to do.
 */
export type RosterOnboarding =
	| { kind: 'none' }
	| { kind: 'open'; complete: number; total: number; overdue: boolean }

export function rosterOnboarding(
	entry: OnboardingSummaryRow | undefined,
	today: string,
): RosterOnboarding {
	if (!entry || entry.total === 0 || entry.complete >= entry.total) {
		return { kind: 'none' }
	}
	return {
		kind: 'open',
		complete: entry.complete,
		total: entry.total,
		overdue: entry.nextDueDate !== null && entry.nextDueDate < today,
	}
}

export type DueLabel = {
	state: TaskDueState
	/** Whole days from today (negative when late); null without a date. */
	days: number | null
}

export function dueLabel(
	task: Pick<OnboardingTask, 'status' | 'dueDate'>,
	today: string,
): DueLabel {
	const state = taskDueState(task, today)
	if (!task.dueDate) return { state, days: null }
	const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
	const [dy, dm, dd] = task.dueDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const days = Math.round(
		(Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000,
	)
	return { state, days }
}

/** Standing of a certificate plus the days it is from today. */
export function certificateView(
	certificate: Pick<StaffCertificate, 'expiresOn'>,
	today: string,
): CertificateStanding {
	return certificateStanding(certificate.expiresOn, today)
}

const ATTENTION_ORDER = { expired: 0, expiring: 1, valid: 2, no_expiry: 3 }

/** Expired first, then expiring soonest, then valid by date, then no expiry. */
export function sortCertificates(
	certificates: readonly StaffCertificate[],
	today: string,
): StaffCertificate[] {
	return [...certificates].sort((a, b) => {
		const sa = certificateStanding(a.expiresOn, today)
		const sb = certificateStanding(b.expiresOn, today)
		const order = ATTENTION_ORDER[sa.status] - ATTENTION_ORDER[sb.status]
		if (order !== 0) return order
		return (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999')
	})
}

// ---------------------------------------------------------------------------
// Template draft
// ---------------------------------------------------------------------------

export type DraftTask = {
	/** Stable key for React lists (not sent). */
	key: string
	type: OnboardingTaskType
	title: string
	instructions: string
	linkUrl: string
	dueInDays: string
	assignee: OnboardingAssignee
	/** Kept as it was so saving a template never drops a member assignment. */
	assigneeUserId: string | null
}

export type TemplateDraft = {
	name: string
	isDefault: boolean
	tasks: DraftTask[]
}

export type DraftErrors = {
	name?: string
	tasks?: string
	task: Record<string, Partial<Record<keyof DraftTask, string>>>
}

let keyCounter = 0
export function newTaskKey(): string {
	keyCounter += 1
	return `task-${keyCounter}`
}

export function emptyDraftTask(
	over: Partial<Omit<DraftTask, 'key'>> = {},
): DraftTask {
	return {
		key: newTaskKey(),
		type: 'custom',
		title: '',
		instructions: '',
		linkUrl: '',
		dueInDays: '3',
		assignee: 'manager',
		assigneeUserId: null,
		...over,
	}
}

export function validateDraft(
	draft: TemplateDraft,
	translate: Translate,
): DraftErrors {
	const errors: DraftErrors = { task: {} }
	if (!draft.name.trim()) {
		errors.name = translate(msg`Give the template a name.`)
	} else if (draft.name.trim().length > ONBOARDING_LIMITS.templateName) {
		errors.name = translate(msg`Use 80 characters or fewer.`)
	}
	if (draft.tasks.length === 0) {
		errors.tasks = translate(msg`Add at least one task.`)
	} else if (draft.tasks.length > ONBOARDING_LIMITS.tasksPerTemplate) {
		errors.tasks = translate(msg`A template can hold up to 30 tasks.`)
	}
	for (const task of draft.tasks) {
		const found: Partial<Record<keyof DraftTask, string>> = {}
		const title = task.title.trim()
		if (!title) found.title = translate(msg`Name the task.`)
		else if (title.length > ONBOARDING_LIMITS.taskTitle) {
			found.title = translate(msg`Use 120 characters or fewer.`)
		} else if (/[<>]/.test(title)) {
			found.title = translate(msg`Leave out the < and > characters.`)
		}
		const days = Number(task.dueInDays)
		if (
			task.dueInDays.trim() === '' ||
			!Number.isInteger(days) ||
			days < 0 ||
			days > ONBOARDING_LIMITS.maxDueInDays
		) {
			found.dueInDays = translate(msg`Enter a whole number from 0 to 90.`)
		}
		if (task.type === 'form_link') {
			if (!task.linkUrl.trim())
				found.linkUrl = translate(msg`Add the link to the form.`)
			else if (!parseFormLink(task.linkUrl.trim())) {
				found.linkUrl = translate(
					msg`Use a full link that starts with https://`,
				)
			}
		}
		if (task.type === 'acknowledge_policy') {
			const text = task.instructions.trim()
			if (!text)
				found.instructions = translate(
					msg`Write the policy they are acknowledging.`,
				)
			else if (text.length > ONBOARDING_LIMITS.instructions) {
				found.instructions = translate(msg`Use 2,000 characters or fewer.`)
			} else if (/[<>]/.test(text)) {
				found.instructions = translate(msg`Leave out the < and > characters.`)
			}
		} else if (
			task.instructions.trim().length > ONBOARDING_LIMITS.instructions
		) {
			found.instructions = translate(msg`Use 2,000 characters or fewer.`)
		}
		if (Object.keys(found).length > 0) errors.task[task.key] = found
	}
	return errors
}

export function hasDraftErrors(errors: DraftErrors): boolean {
	return Boolean(errors.name || errors.tasks || Object.keys(errors.task).length)
}

/** The request body for a draft that passed `validateDraft`. */
export function draftToInput(draft: TemplateDraft) {
	return {
		name: draft.name.trim(),
		isDefault: draft.isDefault,
		tasks: draft.tasks.map((task) => ({
			type: task.type,
			title: task.title.trim(),
			instructions: task.instructions.trim() || null,
			linkUrl: task.type === 'form_link' ? task.linkUrl.trim() : null,
			dueInDays: Number(task.dueInDays),
			assignee: task.assignee,
			assigneeUserId: task.assignee === 'member' ? task.assigneeUserId : null,
		})),
	}
}

/** A template as an editable draft; a member assignee reads as a manager task. */
export function templateToDraft(template: {
	name: string
	isDefault: boolean
	tasks: Array<{
		type: OnboardingTaskType
		title: string
		instructions: string | null
		linkUrl: string | null
		dueInDays: number
		assignee: OnboardingAssignee
		assigneeUserId: string | null
	}>
}): TemplateDraft {
	return {
		name: template.name,
		isDefault: template.isDefault,
		tasks: template.tasks.map((task) =>
			emptyDraftTask({
				type: task.type,
				title: task.title,
				instructions: task.instructions ?? '',
				linkUrl: task.linkUrl ?? '',
				dueInDays: String(task.dueInDays),
				assignee: task.assignee,
				assigneeUserId: task.assigneeUserId,
			}),
		),
	}
}

// ---------------------------------------------------------------------------
// One-off task and certificate forms
// ---------------------------------------------------------------------------

export type TaskFormValues = {
	type: OnboardingTaskType
	title: string
	instructions: string
	linkUrl: string
	/** `YYYY-MM-DD`, or empty for no date. */
	dueDate: string
	assignee: 'manager' | 'staff'
}

export type TaskFormErrors = Partial<Record<keyof TaskFormValues, string>>

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateTaskForm(
	values: TaskFormValues,
	translate: Translate,
): TaskFormErrors {
	const errors: TaskFormErrors = {}
	const title = values.title.trim()
	if (!title) errors.title = translate(msg`Name the task.`)
	else if (title.length > ONBOARDING_LIMITS.taskTitle) {
		errors.title = translate(msg`Use 120 characters or fewer.`)
	} else if (/[<>]/.test(title)) {
		errors.title = translate(msg`Leave out the < and > characters.`)
	}
	if (values.type === 'form_link') {
		if (!values.linkUrl.trim()) {
			errors.linkUrl = translate(msg`Add the link to the form.`)
		} else if (!parseFormLink(values.linkUrl.trim())) {
			errors.linkUrl = translate(msg`Use a full link that starts with https://`)
		}
	}
	const text = values.instructions.trim()
	if (values.type === 'acknowledge_policy' && !text) {
		errors.instructions = translate(
			msg`Write the policy they are acknowledging.`,
		)
	} else if (text.length > ONBOARDING_LIMITS.instructions) {
		errors.instructions = translate(msg`Use 2,000 characters or fewer.`)
	} else if (/[<>]/.test(text)) {
		errors.instructions = translate(msg`Leave out the < and > characters.`)
	}
	if (values.dueDate && !DATE.test(values.dueDate)) {
		errors.dueDate = translate(msg`Pick a date.`)
	}
	return errors
}

export function taskFormToInput(values: TaskFormValues) {
	return {
		type: values.type,
		title: values.title.trim(),
		instructions: values.instructions.trim() || null,
		linkUrl: values.type === 'form_link' ? values.linkUrl.trim() : null,
		dueDate: values.dueDate || null,
		assignee: values.assignee,
		assigneeUserId: null,
	}
}

export type CertificateFormValues = {
	kind: StaffCertificate['kind']
	label: string
	issuedOn: string
	expiresOn: string
	note: string
}

export type CertificateFormErrors = Partial<
	Record<keyof CertificateFormValues, string>
>

export function validateCertificateForm(
	values: CertificateFormValues,
	translate: Translate,
): CertificateFormErrors {
	const errors: CertificateFormErrors = {}
	const label = values.label.trim()
	if (values.kind === 'other' && !label) {
		errors.label = translate(msg`Say what kind of certificate this is.`)
	} else if (label.length > ONBOARDING_LIMITS.label) {
		errors.label = translate(msg`Use 60 characters or fewer.`)
	} else if (/[<>]/.test(label)) {
		errors.label = translate(msg`Leave out the < and > characters.`)
	}
	if (values.issuedOn && !DATE.test(values.issuedOn)) {
		errors.issuedOn = translate(msg`Pick a date.`)
	}
	if (values.expiresOn && !DATE.test(values.expiresOn)) {
		errors.expiresOn = translate(msg`Pick a date.`)
	} else if (
		values.issuedOn &&
		values.expiresOn &&
		values.expiresOn < values.issuedOn
	) {
		errors.expiresOn = translate(
			msg`The expiry date cannot be before the issue date.`,
		)
	}
	const note = values.note.trim()
	if (note.length > ONBOARDING_LIMITS.certificateNote) {
		errors.note = translate(msg`Use 200 characters or fewer.`)
	} else if (/[<>]/.test(note)) {
		errors.note = translate(msg`Leave out the < and > characters.`)
	}
	return errors
}

export function certificateFormToInput(values: CertificateFormValues) {
	return {
		kind: values.kind,
		label: values.label.trim() || null,
		issuedOn: values.issuedOn || null,
		expiresOn: values.expiresOn || null,
		note: values.note.trim() || null,
	}
}
