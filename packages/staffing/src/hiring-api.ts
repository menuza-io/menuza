import { z } from 'zod'
import { opaqueIdSchema } from './internal-api.ts'
import {
	currencySchema,
	e164PhoneSchema,
	localDateSchema,
	moneyMinorSchema,
	payTypeSchema,
	workerTypeSchema,
} from './schemas.ts'
import { MAX_ANSWER_KEYS, type AnswerSnapshot } from './hiring-screener.ts'

/**
 * Contracts for hiring: the public `/careers` apply route (no account, reached
 * browser-direct from the organization's own website) and the manager routes
 * under `/operator/hiring`. App, Sites and tenant-api import the same schemas.
 * Every request schema is `.strict()`: an unknown key is a 400.
 *
 * Residency: applicants, their answers, notes and interviews live in the
 * regional tenant database. A posting is referred to only by its opaque
 * control-plane id plus a snapshot of its title.
 */

export const HIRING_STAGES = [
	'new',
	'screening',
	'interview',
	'offer',
	'hired',
	'declined',
] as const
export type HiringStage = (typeof HIRING_STAGES)[number]

/** The stages a candidate moves through by hand, in board order. */
export const HIRING_OPEN_STAGES = [
	'new',
	'screening',
	'interview',
	'offer',
] as const
export type HiringOpenStage = (typeof HIRING_OPEN_STAGES)[number]

export function isHiringStage(value: unknown): value is HiringStage {
	return (
		typeof value === 'string' &&
		(HIRING_STAGES as readonly string[]).includes(value)
	)
}

export function isOpenHiringStage(value: unknown): value is HiringOpenStage {
	return (
		typeof value === 'string' &&
		(HIRING_OPEN_STAGES as readonly string[]).includes(value)
	)
}

/**
 * Where a candidate may be moved by hand. Hiring is its own action (it creates
 * the staff record), declining has its own action (it records why and can send
 * the applicant a message), and a hired candidate is a staff member now. A
 * declined candidate can be reopened into any open stage.
 */
export function canMoveHiringStage(
	from: HiringStage,
	to: HiringStage,
): boolean {
	if (from === to) return false
	if (to === 'hired' || to === 'declined') return false
	if (from === 'hired') return false
	return true
}

export const HIRING_SOURCES = ['careers_page', 'qr', 'share_link'] as const
export type HiringSource = (typeof HIRING_SOURCES)[number]

/**
 * The version of the notice the apply form shows next to the consent box. It is
 * stored with every application, and a version this server does not know is
 * refused, so a stale cached form can never record consent to wording that no
 * longer exists.
 */
export const HIRING_CONSENT_VERSION = '2026-10'
export const HIRING_CONSENT_VERSIONS: readonly string[] = [
	HIRING_CONSENT_VERSION,
]

/**
 * How long a declined applicant's record is kept, when the organization has not
 * chosen (placeholder pending counsel, ADR 047 decision 9).
 */
export const HIRING_DEFAULT_RETENTION_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

export function resolveApplicantRetentionDays(
	configured: number | null | undefined,
): number {
	return typeof configured === 'number' &&
		Number.isInteger(configured) &&
		configured > 0
		? Math.min(configured, 3650)
		: HIRING_DEFAULT_RETENTION_DAYS
}

/** When a record declined at `declinedAt` is due to be purged. */
export function declinedRetentionExpiry(
	declinedAt: number,
	configuredDays: number | null | undefined,
): number {
	return declinedAt + resolveApplicantRetentionDays(configuredDays) * DAY_MS
}

export const HIRING_LIMITS = {
	name: 80,
	email: 254,
	phone: 20,
	note: 2_000,
	interviewDetails: 500,
	interviewOutcome: 1_000,
	postingTitle: 120,
	search: 80,
	listMax: 200,
	/** Applications one person may have open for one posting (dedupe). */
	perOrgPerHour: 60,
	perIpPerHour: 5,
	perIpPerDay: 12,
} as const

const idSchema = opaqueIdSchema

/**
 * Applicants type phone numbers the way they write them. Spaces, dashes, dots
 * and brackets are dropped and a leading `00` means `+`; what is left must be
 * a real international number. A national format without a country code is
 * ambiguous and is refused, so the form asks for one.
 */
export function normalizeApplicantPhone(raw: string): string | null {
	const stripped = raw.replace(/[\s().-]/g, '')
	const withPlus = stripped.startsWith('00')
		? `+${stripped.slice(2)}`
		: stripped
	return e164PhoneSchema.safeParse(withPlus).success ? withPlus : null
}

/** Lower-cased, trimmed email for matching and storage. */
export function normalizeApplicantEmail(raw: string): string {
	return raw.trim().toLowerCase()
}

const personName = z
	.string()
	.trim()
	.min(1)
	.max(HIRING_LIMITS.name)
	// A name never carries markup or control characters.
	.refine(
		(value) =>
			![...value].some((char) => {
				const code = char.codePointAt(0)!
				return char === '<' || char === '>' || code < 0x20 || code === 0x7f
			}),
		'Invalid characters',
	)

const phoneInput = z
	.string()
	.max(40)
	.transform((value, ctx) => {
		const normalized = normalizeApplicantPhone(value)
		if (!normalized) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone_format' })
			return z.NEVER
		}
		return normalized
	})

const emailInput = z
	.string()
	.trim()
	.toLowerCase()
	.email()
	.max(HIRING_LIMITS.email)

// ---------------------------------------------------------------------------
// Public: apply
// ---------------------------------------------------------------------------

/**
 * The public application. Which organization it is for is never taken from
 * here: tenant-api resolves it from the browser's `Origin`. `slug` and `host`
 * are accepted only so a local dev origin (no tenant subdomain) can name an
 * organization, and a value that disagrees with a real Origin is refused.
 *
 * The honeypot (`website`) and the challenge token are read before this schema
 * runs and are listed here only so a well-formed form is not rejected as
 * having unknown keys.
 */
export const careersApplySchema = z
	.object({
		slug: z.string().trim().max(63).optional(),
		host: z.string().trim().max(253).optional(),
		postingSlug: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		firstName: personName,
		lastName: personName,
		email: emailInput.optional(),
		phone: phoneInput.optional(),
		/**
		 * Where the person would work, when the job is at more than one scope:
		 * one or more of the posting's own scopes (the server checks them).
		 * `scopeId` is the same thing for a single place.
		 */
		scopeIds: z.array(idSchema).max(100).optional(),
		scopeId: idSchema.optional(),
		locale: z.enum(['en', 'ar']).default('en'),
		answers: z
			.record(
				z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
				z.union([z.string().max(8_000), z.boolean()]),
			)
			.refine((value) => Object.keys(value).length <= MAX_ANSWER_KEYS, {
				message: 'Too many answers',
			})
			.default({}),
		source: z.enum(HIRING_SOURCES).default('careers_page'),
		consent: z.literal(true),
		consentVersion: z
			.string()
			.max(32)
			.refine((value) => HIRING_CONSENT_VERSIONS.includes(value), {
				message: 'unknown_consent_version',
			}),
		website: z.string().max(200).optional(),
		turnstileToken: z.string().max(2048).optional(),
	})
	.strict()
	.refine((value) => value.email !== undefined || value.phone !== undefined, {
		message: 'contact_required',
		path: ['email'],
	})
export type CareersApplyInput = z.infer<typeof careersApplySchema>

/** What the careers form is told. The same body for new and repeat applications. */
export const careersApplyResponseSchema = z
	.object({ received: z.literal(true) })
	.strict()

/** A hard ceiling on the body the apply route reads, before any parsing. */
export const CAREERS_APPLY_MAX_BODY_BYTES = 32 * 1024

// ---------------------------------------------------------------------------
// Operator: list and detail
// ---------------------------------------------------------------------------

export const HIRING_SORTS = ['newest', 'oldest', 'score', 'name'] as const

export const hiringListQuerySchema = z
	.object({
		/** One stage, or `open` for every stage still in the running. */
		stage: z.enum([...HIRING_STAGES, 'open']).optional(),
		postingId: idSchema.optional(),
		scopeId: idSchema.optional(),
		/** Only candidates the screener flagged. */
		flagged: z
			.enum(['1', 'true'])
			.transform(() => true)
			.optional(),
		q: z
			.string()
			.trim()
			.min(1)
			.max(HIRING_LIMITS.search)
			.refine(
				(value) =>
					![...value].some((char) => {
						const code = char.codePointAt(0)!
						return code < 0x20 || code === 0x7f
					}),
				'Invalid search text',
			)
			.optional(),
		sort: z.enum(HIRING_SORTS).default('newest'),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(HIRING_LIMITS.listMax)
			.default(100),
		offset: z.coerce.number().int().min(0).max(100_000).default(0),
	})
	.strict()
export type HiringListQuery = z.infer<typeof hiringListQuerySchema>

/** A row of the pipeline. No contact details and no answers. */
export type HiringApplicationSummary = {
	id: string
	postingId: string
	postingTitle: string
	scopeId: string | null
	firstName: string
	lastName: string
	source: HiringSource
	stage: HiringStage
	stageChangedAt: number
	screenerScore: number | null
	flagCount: number
	hasEmail: boolean
	hasPhone: boolean
	interviewAt: number | null
	noteCount: number
	hiredStaffId: string | null
	createdAt: number
}

export type HiringListResponse = {
	applications: HiringApplicationSummary[]
	/** Counts per stage for the same filters, ignoring `stage` itself. */
	counts: Record<HiringStage, number>
	postings: Array<{ postingId: string; title: string; count: number }>
	total: number
}

export const HIRING_TIMELINE_KINDS = [
	'applied',
	'stage_changed',
	'note_added',
	'interview_scheduled',
	'interview_updated',
	'invite_sent',
	'declined',
	'reopened',
	'decline_email_sent',
	'hired',
] as const
export type HiringTimelineKind = (typeof HIRING_TIMELINE_KINDS)[number]

export type HiringTimelineEvent = {
	id: string
	kind: HiringTimelineKind
	at: number
	/** Opaque operator user id; `null` for the applicant or the system. */
	actorId: string | null
	fromStage: HiringStage | null
	toStage: HiringStage | null
	/** A short code (a decline reason, a failure), never free text. */
	detail: string | null
}

export const INTERVIEW_MODES = ['in_person', 'phone', 'video'] as const
export type InterviewMode = (typeof INTERVIEW_MODES)[number]
export const INTERVIEW_STATUSES = [
	'scheduled',
	'completed',
	'cancelled',
	'no_show',
] as const
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number]
export const INVITE_STATUSES = [
	'not_sent',
	'sent',
	'failed',
	'no_email',
	'email_disabled',
] as const
export type InviteStatus = (typeof INVITE_STATUSES)[number]

export type HiringInterview = {
	id: string
	applicationId: string
	scopeId: string | null
	scheduledAt: number
	durationMinutes: number
	mode: InterviewMode
	details: string | null
	status: InterviewStatus
	outcome: string | null
	inviteStatus: InviteStatus
	inviteSentAt: number | null
	createdBy: string
	createdAt: number
}

export type HiringNote = {
	id: string
	applicationId: string
	authorId: string
	body: string
	createdAt: number
}

export type HiringApplicationDetail = Omit<
	HiringApplicationSummary,
	'hasEmail' | 'hasPhone' | 'noteCount' | 'interviewAt'
> & {
	email: string | null
	phone: string | null
	locale: 'en' | 'ar'
	positionName: string | null
	answers: AnswerSnapshot[]
	/** Question ids of dealbreakers whose answer differs from the wanted one. */
	flags: string[]
	declinedReason: string | null
	declinedAt: number | null
	consentAt: number
	consentVersion: string
	retentionExpiresAt: number | null
	/** Days a declined applicant's record is kept (the organization's setting). */
	declineRetentionDays: number
	hiredAt: number | null
	notes: HiringNote[]
	interviews: HiringInterview[]
	timeline: HiringTimelineEvent[]
}

// ---------------------------------------------------------------------------
// Operator: changes
// ---------------------------------------------------------------------------

export const hiringStageMoveSchema = z
	.object({ stage: z.enum(HIRING_OPEN_STAGES) })
	.strict()

export const hiringNoteInputSchema = z
	.object({ body: z.string().trim().min(1).max(HIRING_LIMITS.note) })
	.strict()

export const interviewCreateSchema = z
	.object({
		/** Epoch milliseconds, in the future (up to a year out). */
		scheduledAt: z.number().int().positive(),
		durationMinutes: z.number().int().min(10).max(480).default(30),
		mode: z.enum(INTERVIEW_MODES).default('in_person'),
		details: z.string().trim().max(HIRING_LIMITS.interviewDetails).optional(),
		/**
		 * Where it takes place. Defaults to the job's scope; a job for the whole
		 * organization needs one, because the time is shown in its time zone.
		 */
		scopeId: idSchema.optional(),
		/** Email the applicant the time and details (needs an email on file). */
		sendInvite: z.boolean().default(true),
	})
	.strict()
export type InterviewCreate = z.infer<typeof interviewCreateSchema>

export const interviewUpdateSchema = z
	.object({
		scheduledAt: z.number().int().positive(),
		durationMinutes: z.number().int().min(10).max(480),
		mode: z.enum(INTERVIEW_MODES),
		details: z.string().trim().max(HIRING_LIMITS.interviewDetails).nullable(),
		status: z.enum(INTERVIEW_STATUSES),
		outcome: z.string().trim().max(HIRING_LIMITS.interviewOutcome).nullable(),
		/** Send the invitation again, with the current time and details. */
		resendInvite: z.boolean(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type InterviewUpdate = z.infer<typeof interviewUpdateSchema>

export const DECLINE_REASONS = [
	'not_a_fit',
	'position_filled',
	'not_available',
	'missing_requirements',
	'withdrew',
	'no_response',
] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]

/** The message an applicant gets. `none` records the decision silently. */
export const DECLINE_TEMPLATES = [
	'none',
	'thanks',
	'position_filled',
	'keep_on_file',
] as const
export type DeclineTemplate = (typeof DECLINE_TEMPLATES)[number]

export const hiringDeclineSchema = z
	.object({
		reason: z.enum(DECLINE_REASONS),
		template: z.enum(DECLINE_TEMPLATES).default('thanks'),
	})
	.strict()
export type HiringDecline = z.infer<typeof hiringDeclineSchema>

/**
 * The hire. Everything is created in one regional transaction: the staff
 * record, the assignment, the position (with pay when the token may set it), and
 * the onboarding checklist. Pay fields need `update:staff_pay:any`.
 */
export const hiringHireSchema = z
	.object({
		scopeId: idSchema,
		positionId: idSchema,
		hiredDate: localDateSchema,
		workerType: workerTypeSchema.default('employee'),
		employeeNumber: z.string().trim().max(40).optional(),
		payType: payTypeSchema.default('hourly'),
		rateMinor: moneyMinorSchema.nullable().default(null),
		annualSalaryMinor: moneyMinorSchema.nullable().default(null),
		/** The scope's currency (the App knows it; this node does not). */
		currency: currencySchema,
		overtimeExempt: z.boolean().default(false),
		tipEligible: z.boolean().default(false),
		/** Create the onboarding checklist for the new person. */
		startOnboarding: z.boolean().default(true),
		/** Which template to copy; omitted uses the default template, else the built-in list. */
		templateId: idSchema.optional(),
	})
	.strict()
	.refine((job) => job.payType !== 'salary' || job.annualSalaryMinor !== null, {
		message: 'Salary jobs need an annual salary',
		path: ['annualSalaryMinor'],
	})
export type HiringHire = z.infer<typeof hiringHireSchema>

export type HiringHireResult = {
	staffId: string
	applicationId: string
	onboardingTasks: number
	/** The email on the application, so the App can offer an app invitation. */
	inviteEmail: string | null
}

// ---------------------------------------------------------------------------
// Onboarding checklist created at hire
// ---------------------------------------------------------------------------

/**
 * The tasks a new hire starts with. Titles are not stored for these: the App
 * renders the label for the key in the viewer's language, so the checklist is
 * read in Arabic by an Arabic-speaking manager. Custom tasks (a later slice)
 * carry their own title.
 */
export const ONBOARDING_DEFAULT_TASKS = [
	{ key: 'confirm_contact', dueInDays: 0 },
	{ key: 'emergency_contact', dueInDays: 3 },
	{ key: 'share_house_rules', dueInDays: 3 },
	{ key: 'set_up_clock_pin', dueInDays: 3 },
	{ key: 'add_to_schedule', dueInDays: 7 },
] as const
export type OnboardingTaskKey = (typeof ONBOARDING_DEFAULT_TASKS)[number]['key']

export const ONBOARDING_TASK_STATUSES = ['todo', 'done', 'skipped'] as const
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number]

// ---------------------------------------------------------------------------
// Public posting facts tenant-api needs from the control plane
// ---------------------------------------------------------------------------

/**
 * What the App tells tenant-api about a live posting (internal route,
 * `INTERNAL_COMMAND_TOKEN`). It includes which answers are dealbreakers, which
 * the public page never shows, so it is used only server to server.
 */
export const internalJobPostingSchema = z
	.object({
		orgId: idSchema,
		posting: z
			.object({
				id: idSchema,
				slug: z.string().min(1).max(80),
				title: z.string().min(1).max(HIRING_LIMITS.postingTitle),
				positionName: z.string().max(80),
				/** Where an applicant may say they apply: the posting's scopes. */
				scopeIds: z.array(idSchema).max(100),
				questions: z.array(z.unknown()).max(10),
			})
			.strict(),
	})
	.strict()
export type InternalJobPosting = z.infer<typeof internalJobPostingSchema>

/** Query for the internal posting route. */
export const STAFFING_JOB_POSTING_PATH = '/resources/staffing/job-posting'
