import { z } from 'zod'
import { opaqueIdSchema } from './internal-api.ts'
import { localDateSchema } from './schemas.ts'
import { addDays, daysBetween } from './tz.ts'

/**
 * Onboarding checklists and certificates: contracts and the pure rules behind
 * them. Everything under `/operator/hiring/onboarding` and
 * `/operator/hiring/certificates` uses these schemas, and the App imports the
 * same ones. Request schemas are `.strict()`: an unknown key is a 400.
 *
 * Scope of v1 (ADR 047):
 * - A task is a checklist item a manager ticks off: review the profile,
 *   acknowledge a policy, complete a form the organization hosts elsewhere (by
 *   link), or anything custom. There is no document upload (it needs in-region
 *   object storage), and there are no tax-form, national-id, bank or similar
 *   fields anywhere: nothing here can hold them.
 * - A certificate records that a person holds one and when it lapses. No
 *   certificate number and no scan.
 * - Dates are `YYYY-MM-DD` calendar days in the person's scope.
 *
 * Residency: this is staff data, so it lives in the regional database and is
 * reached browser-direct. Only a count, a kind of alert and a scope id may
 * ever cross to the control plane (see the manager alert contract).
 */

const idSchema = opaqueIdSchema

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ONBOARDING_TASK_TYPES = [
	'review_profile',
	'acknowledge_policy',
	'form_link',
	'custom',
] as const
export type OnboardingTaskType = (typeof ONBOARDING_TASK_TYPES)[number]

export function isOnboardingTaskType(
	value: unknown,
): value is OnboardingTaskType {
	return (
		typeof value === 'string' &&
		(ONBOARDING_TASK_TYPES as readonly string[]).includes(value)
	)
}

/** Who a task is for: any manager, the new hire themself, or one member. */
export const ONBOARDING_ASSIGNEES = ['manager', 'staff', 'member'] as const
export type OnboardingAssignee = (typeof ONBOARDING_ASSIGNEES)[number]

export const ONBOARDING_STATUSES = ['todo', 'done', 'skipped'] as const
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number]

export const ONBOARDING_SOURCES = ['hire', 'manual', 'template'] as const
export type OnboardingSource = (typeof ONBOARDING_SOURCES)[number]

export const CERTIFICATE_KINDS = [
	'food_handler',
	'health_card',
	'alcohol_service',
	'first_aid',
	'fire_safety',
	'other',
] as const
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number]

export const ONBOARDING_LIMITS = {
	templateName: 80,
	taskTitle: 120,
	instructions: 2_000,
	linkUrl: 500,
	label: 60,
	certificateNote: 200,
	tasksPerTemplate: 30,
	tasksPerPerson: 60,
	templates: 25,
	certificatesPerPerson: 30,
	maxDueInDays: 90,
	/** How many days before expiry a certificate is called "expiring". */
	certificateWarnDays: 30,
	/** An overdue reminder goes out this many days after the due date. */
	overdueReminderDays: 3,
} as const

// ---------------------------------------------------------------------------
// Built-in checklist
// ---------------------------------------------------------------------------

/**
 * The type of each built-in task key. The built-in checklist keeps no title
 * (the App renders the label for the key in the viewer's language).
 */
export const BUILTIN_TASK_TYPES: Record<string, OnboardingTaskType> = {
	confirm_contact: 'review_profile',
	emergency_contact: 'custom',
	share_house_rules: 'custom',
	set_up_clock_pin: 'custom',
	add_to_schedule: 'custom',
}

export function builtinTaskType(key: string | null): OnboardingTaskType {
	return (key && BUILTIN_TASK_TYPES[key]) || 'custom'
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

const hasMarkupOrControl = (value: string) =>
	[...value].some((char) => {
		const code = char.codePointAt(0)!
		return char === '<' || char === '>' || code < 0x20 || code === 0x7f
	})

const plainText = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((value) => !hasMarkupOrControl(value), 'Invalid characters')

/** Instructions may span lines, but never carry markup or control characters. */
const instructionsText = z
	.string()
	.trim()
	.min(1)
	.max(ONBOARDING_LIMITS.instructions)
	.refine(
		(value) =>
			![...value].some((char) => {
				const code = char.codePointAt(0)!
				return (
					char === '<' ||
					char === '>' ||
					(code < 0x20 && char !== '\n') ||
					code === 0x7f
				)
			}),
		'Invalid characters',
	)

/**
 * A link to a form the organization hosts itself. Only `https:` is accepted, with
 * no embedded credentials, so a stored link can never be a `javascript:` or
 * `data:` URL and never carries a password.
 */
export function parseFormLink(value: string): string | null {
	if (value.length > ONBOARDING_LIMITS.linkUrl) return null
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== 'https:') return null
	if (url.username || url.password) return null
	if (!url.hostname || !url.hostname.includes('.')) return null
	return url.toString()
}

export const formLinkSchema = z
	.string()
	.trim()
	.min(1)
	.max(ONBOARDING_LIMITS.linkUrl)
	.transform((value, ctx) => {
		const parsed = parseFormLink(value)
		if (!parsed) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'form_link' })
			return z.NEVER
		}
		return parsed
	})

const taskShape = {
	type: z.enum(ONBOARDING_TASK_TYPES),
	title: plainText(ONBOARDING_LIMITS.taskTitle),
	instructions: instructionsText.nullable().default(null),
	linkUrl: formLinkSchema.nullable().default(null),
	assignee: z.enum(ONBOARDING_ASSIGNEES).default('manager'),
	assigneeUserId: idSchema.nullable().default(null),
}

type TaskRules = {
	type: OnboardingTaskType
	instructions: string | null
	linkUrl: string | null
	assignee: OnboardingAssignee
	assigneeUserId: string | null
}

/**
 * Cross-field rules shared by template tasks and one-off tasks. Returns the
 * first problem as `[path, code]`, or null.
 */
export function checkTaskRules(task: TaskRules): [string, string] | null {
	if (task.type === 'form_link' && !task.linkUrl) {
		return ['linkUrl', 'link_required']
	}
	if (task.type !== 'form_link' && task.linkUrl) {
		return ['linkUrl', 'link_not_allowed']
	}
	if (task.type === 'acknowledge_policy' && !task.instructions) {
		return ['instructions', 'policy_text_required']
	}
	if (task.assignee === 'member' && !task.assigneeUserId) {
		return ['assigneeUserId', 'member_required']
	}
	if (task.assignee !== 'member' && task.assigneeUserId) {
		return ['assigneeUserId', 'member_not_allowed']
	}
	return null
}

function withTaskRules<T extends z.ZodType<TaskRules, unknown>>(schema: T): T {
	return schema.superRefine((value, ctx) => {
		const problem = checkTaskRules(value)
		if (problem) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [problem[0]],
				message: problem[1],
			})
		}
	})
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const onboardingTemplateTaskSchema = withTaskRules(
	z
		.object({
			...taskShape,
			dueInDays: z.number().int().min(0).max(ONBOARDING_LIMITS.maxDueInDays),
		})
		.strict(),
)
export type OnboardingTemplateTaskInput = z.infer<
	typeof onboardingTemplateTaskSchema
>

/** Create or replace a template. Tasks are replaced as a whole, in order. */
export const onboardingTemplateInputSchema = z
	.object({
		name: plainText(ONBOARDING_LIMITS.templateName),
		isDefault: z.boolean().default(false),
		tasks: z
			.array(onboardingTemplateTaskSchema)
			.min(1)
			.max(ONBOARDING_LIMITS.tasksPerTemplate),
	})
	.strict()
export type OnboardingTemplateInput = z.infer<
	typeof onboardingTemplateInputSchema
>

/** Copy a template (or, with none given, the default) onto a person. */
export const onboardingApplySchema = z
	.object({
		templateId: idSchema.optional(),
		/** Due dates count from this day. Defaults to the hire date, else today. */
		baseDate: localDateSchema.optional(),
	})
	.strict()
export type OnboardingApply = z.infer<typeof onboardingApplySchema>

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const onboardingTaskCreateSchema = withTaskRules(
	z
		.object({
			...taskShape,
			dueDate: localDateSchema.nullable().default(null),
		})
		.strict(),
)
export type OnboardingTaskCreate = z.infer<typeof onboardingTaskCreateSchema>

/**
 * Change one task. A status change is the common case; the other fields edit a
 * task that was added by hand or copied from a template. At least one field.
 */
export const onboardingTaskUpdateSchema = z
	.object({
		status: z.enum(ONBOARDING_STATUSES).optional(),
		title: plainText(ONBOARDING_LIMITS.taskTitle).optional(),
		instructions: instructionsText.nullable().optional(),
		linkUrl: formLinkSchema.nullable().optional(),
		dueDate: localDateSchema.nullable().optional(),
		assignee: z.enum(ONBOARDING_ASSIGNEES).optional(),
		assigneeUserId: idSchema.nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to change')
export type OnboardingTaskUpdate = z.infer<typeof onboardingTaskUpdateSchema>

export const onboardingSummaryQuerySchema = z
	.object({
		/** Comma-separated staff ids (the roster page being shown). */
		staffIds: z
			.string()
			.max(4_000)
			.transform((value) => value.split(',').filter(Boolean))
			.pipe(z.array(idSchema).max(200))
			.optional(),
	})
	.strict()

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export const certificateInputSchema = z
	.object({
		kind: z.enum(CERTIFICATE_KINDS),
		label: plainText(ONBOARDING_LIMITS.label).nullable().default(null),
		issuedOn: localDateSchema.nullable().default(null),
		expiresOn: localDateSchema.nullable().default(null),
		note: plainText(ONBOARDING_LIMITS.certificateNote).nullable().default(null),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.kind === 'other' && !value.label) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['label'],
				message: 'label_required',
			})
		}
		if (value.issuedOn && value.expiresOn && value.expiresOn < value.issuedOn) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['expiresOn'],
				message: 'expires_before_issued',
			})
		}
	})
export type CertificateInput = z.infer<typeof certificateInputSchema>

export const certificateUpdateSchema = z
	.object({
		kind: z.enum(CERTIFICATE_KINDS).optional(),
		label: plainText(ONBOARDING_LIMITS.label).nullable().optional(),
		issuedOn: localDateSchema.nullable().optional(),
		expiresOn: localDateSchema.nullable().optional(),
		note: plainText(ONBOARDING_LIMITS.certificateNote).nullable().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to change')
export type CertificateUpdate = z.infer<typeof certificateUpdateSchema>

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type OnboardingTaskView = {
	id: string
	staffId: string
	/** Built-in tasks carry a key and no title; the App renders the label. */
	taskKey: string | null
	title: string | null
	type: OnboardingTaskType
	instructions: string | null
	linkUrl: string | null
	assignee: OnboardingAssignee
	assigneeUserId: string | null
	templateId: string | null
	status: OnboardingStatus
	dueDate: string | null
	sortOrder: number
	source: OnboardingSource
	completedAt: number | null
	completedBy: string | null
	createdAt: number
}

export type OnboardingTemplateTaskView = {
	id: string
	type: OnboardingTaskType
	title: string
	instructions: string | null
	linkUrl: string | null
	dueInDays: number
	assignee: OnboardingAssignee
	assigneeUserId: string | null
	sortOrder: number
}

export type OnboardingTemplateView = {
	id: string
	name: string
	isDefault: boolean
	archivedAt: number | null
	tasks: OnboardingTemplateTaskView[]
	updatedAt: number
}

export type OnboardingChecklistResponse = {
	tasks: OnboardingTaskView[]
}

/**
 * One person's checklist at a glance, for the roster. The earliest open due date
 * is returned instead of an "overdue" count because "overdue" depends on the
 * person's scope day, which the App knows and this node does not.
 */
export type OnboardingSummaryEntry = {
	staffId: string
	total: number
	complete: number
	nextDueDate: string | null
}

export type CertificateView = {
	id: string
	staffId: string
	kind: CertificateKind
	label: string | null
	issuedOn: string | null
	expiresOn: string | null
	note: string | null
	createdAt: number
	updatedAt: number
}

// ---------------------------------------------------------------------------
// Pure rules: progress, due state, expiry, reminders
// ---------------------------------------------------------------------------

export type TaskLike = {
	status: OnboardingStatus
	dueDate: string | null
}

export type TaskDueState =
	'done' | 'skipped' | 'overdue' | 'due_today' | 'upcoming' | 'no_date'

/** Where one task stands on `today` (a `YYYY-MM-DD` in the person's scope). */
export function taskDueState(task: TaskLike, today: string): TaskDueState {
	if (task.status === 'done') return 'done'
	if (task.status === 'skipped') return 'skipped'
	if (!task.dueDate) return 'no_date'
	if (task.dueDate < today) return 'overdue'
	if (task.dueDate === today) return 'due_today'
	return 'upcoming'
}

export type OnboardingProgress = {
	total: number
	/** Done plus skipped: nothing left to do for these. */
	complete: number
	overdue: number
	/** 0 to 100; 0 for an empty checklist. */
	percent: number
	state: 'none' | 'not_started' | 'in_progress' | 'complete'
}

export function onboardingProgress(
	tasks: readonly TaskLike[],
	today: string,
): OnboardingProgress {
	const total = tasks.length
	if (total === 0) {
		return { total: 0, complete: 0, overdue: 0, percent: 0, state: 'none' }
	}
	let complete = 0
	let done = 0
	let overdue = 0
	for (const task of tasks) {
		const state = taskDueState(task, today)
		if (state === 'done' || state === 'skipped') complete++
		if (state === 'done') done++
		if (state === 'overdue') overdue++
	}
	return {
		total,
		complete,
		overdue,
		percent: Math.round((complete / total) * 100),
		state:
			complete === total
				? 'complete'
				: done === 0 && complete === 0
					? 'not_started'
					: 'in_progress',
	}
}

/**
 * The reminder stage a task has reached: 0 nothing yet, 1 it is due, 2 it has
 * been overdue for `overdueReminderDays`. Only open tasks with a date remind.
 */
export function taskReminderStage(task: TaskLike, today: string): 0 | 1 | 2 {
	if (task.status !== 'todo' || !task.dueDate) return 0
	if (
		daysBetween(task.dueDate, today) >= ONBOARDING_LIMITS.overdueReminderDays
	) {
		return 2
	}
	return task.dueDate <= today ? 1 : 0
}

export type CertificateStatus = 'no_expiry' | 'valid' | 'expiring' | 'expired'

export type CertificateStanding = {
	status: CertificateStatus
	/** Whole days until the last valid day; negative once expired; null if none. */
	daysLeft: number | null
}

/**
 * A certificate is valid through the `expiresOn` day and expired the day after.
 * It is "expiring" for the last `warnDays` days it is valid.
 */
export function certificateStanding(
	expiresOn: string | null,
	today: string,
	warnDays: number = ONBOARDING_LIMITS.certificateWarnDays,
): CertificateStanding {
	if (!expiresOn) return { status: 'no_expiry', daysLeft: null }
	const daysLeft = daysBetween(today, expiresOn)
	if (daysLeft < 0) return { status: 'expired', daysLeft }
	if (daysLeft <= warnDays) return { status: 'expiring', daysLeft }
	return { status: 'valid', daysLeft }
}

/** 0 fine, 1 expiring soon, 2 expired: the alert stage a certificate has reached. */
export function certificateAlertStage(
	expiresOn: string | null,
	today: string,
): 0 | 1 | 2 {
	const { status } = certificateStanding(expiresOn, today)
	return status === 'expired' ? 2 : status === 'expiring' ? 1 : 0
}

/** The due date for a template task copied onto a person on `baseDate`. */
export function dueDateFrom(baseDate: string, dueInDays: number): string {
	return addDays(baseDate, dueInDays)
}

/**
 * Move one item up (-1) or down (+1) in an ordered list, for builders that
 * reorder with buttons. Out-of-range moves return the list unchanged.
 */
export function moveItem<T>(
	items: readonly T[],
	index: number,
	direction: -1 | 1,
): T[] {
	const target = index + direction
	if (
		index < 0 ||
		index >= items.length ||
		target < 0 ||
		target >= items.length
	) {
		return [...items]
	}
	const next = [...items]
	const [item] = next.splice(index, 1)
	next.splice(target, 0, item!)
	return next
}
