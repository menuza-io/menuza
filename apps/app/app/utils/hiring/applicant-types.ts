import {
	DECLINE_REASONS,
	HIRING_SOURCES,
	HIRING_STAGES,
	HIRING_TIMELINE_KINDS,
	INTERVIEW_MODES,
	INTERVIEW_STATUSES,
	INVITE_STATUSES,
	type StaffingCurrency,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/hiring`, parsed in the browser. They mirror the
 * response types in `@repo/staffing` (`hiring-api.ts`). Enumerations read as
 * plain strings through `.catch`: a stage, kind or source added on a newer node
 * must never make an older screen refuse the whole page.
 */

const stage = z.enum(HIRING_STAGES).catch('new')
const source = z.enum(HIRING_SOURCES).catch('careers_page')

export const applicantSummarySchema = z.object({
	id: z.string(),
	postingId: z.string(),
	postingTitle: z.string(),
	scopeId: z.string().nullable(),
	/** Every scope (location) the person is interested in, the primary one included. */
	interestedScopeIds: z.array(z.string()).default([]),
	firstName: z.string(),
	lastName: z.string(),
	source,
	stage,
	stageChangedAt: z.number(),
	screenerScore: z.number().nullable(),
	flagCount: z.number(),
	hasEmail: z.boolean(),
	hasPhone: z.boolean(),
	interviewAt: z.number().nullable(),
	noteCount: z.number(),
	hiredStaffId: z.string().nullable(),
	createdAt: z.number(),
})
export type ApplicantSummary = z.infer<typeof applicantSummarySchema>

export const applicantListSchema = z.object({
	applications: z.array(applicantSummarySchema),
	counts: z.record(z.string(), z.number()),
	postings: z.array(
		z.object({ postingId: z.string(), title: z.string(), count: z.number() }),
	),
	total: z.number(),
})
export type ApplicantList = z.infer<typeof applicantListSchema>

const answerSchema = z.discriminatedUnion('kind', [
	z.object({
		id: z.string(),
		kind: z.literal('yes_no'),
		prompt: z.string(),
		category: z.string().optional(),
		answer: z.enum(['yes', 'no']),
		requiredAnswer: z.enum(['yes', 'no']),
		dealbreaker: z.boolean(),
	}),
	z.object({
		id: z.string(),
		kind: z.literal('open'),
		prompt: z.string(),
		answer: z.string(),
	}),
])
export type ApplicantAnswer = z.infer<typeof answerSchema>

export const applicantNoteSchema = z.object({
	id: z.string(),
	applicationId: z.string(),
	authorId: z.string(),
	body: z.string(),
	createdAt: z.number(),
})
export type ApplicantNote = z.infer<typeof applicantNoteSchema>

export const interviewSchema = z.object({
	id: z.string(),
	applicationId: z.string(),
	scopeId: z.string().nullable(),
	scheduledAt: z.number(),
	durationMinutes: z.number(),
	mode: z.enum(INTERVIEW_MODES).catch('in_person'),
	details: z.string().nullable(),
	status: z.enum(INTERVIEW_STATUSES).catch('scheduled'),
	outcome: z.string().nullable(),
	inviteStatus: z.enum(INVITE_STATUSES).catch('not_sent'),
	inviteSentAt: z.number().nullable(),
	createdBy: z.string(),
	createdAt: z.number(),
})
export type ApplicantInterview = z.infer<typeof interviewSchema>

export const timelineEventSchema = z.object({
	id: z.string(),
	// An unknown kind still shows, as a generic line.
	kind: z.enum(HIRING_TIMELINE_KINDS).catch('stage_changed'),
	at: z.number(),
	actorId: z.string().nullable(),
	fromStage: z.enum(HIRING_STAGES).nullable().catch(null),
	toStage: z.enum(HIRING_STAGES).nullable().catch(null),
	detail: z.string().nullable(),
})
export type ApplicantTimelineEvent = z.infer<typeof timelineEventSchema>

export const applicantDetailSchema = applicantSummarySchema
	.omit({ hasEmail: true, hasPhone: true, noteCount: true, interviewAt: true })
	.extend({
		email: z.string().nullable(),
		phone: z.string().nullable(),
		locale: z.enum(['en', 'ar']).catch('en'),
		positionName: z.string().nullable(),
		answers: z.array(answerSchema),
		flags: z.array(z.string()),
		declinedReason: z.enum(DECLINE_REASONS).nullable().catch(null),
		declinedAt: z.number().nullable(),
		consentAt: z.number(),
		consentVersion: z.string(),
		retentionExpiresAt: z.number().nullable(),
		declineRetentionDays: z.number(),
		hiredAt: z.number().nullable(),
		notes: z.array(applicantNoteSchema),
		interviews: z.array(interviewSchema),
		timeline: z.array(timelineEventSchema),
	})
export type ApplicantDetail = z.infer<typeof applicantDetailSchema>

export const stageMoveResultSchema = z.object({
	application: applicantSummarySchema,
})

export const declineResultSchema = z.object({
	application: applicantSummarySchema,
	email: z.enum(['none', 'sent', 'failed', 'no_email', 'email_disabled']),
})
export type DeclineResult = z.infer<typeof declineResultSchema>

export const hireResultSchema = z.object({
	staffId: z.string(),
	applicationId: z.string(),
	onboardingTasks: z.number(),
	inviteEmail: z.string().nullable(),
})
export type HireResult = z.infer<typeof hireResultSchema>

export const interviewResultSchema = z.object({ interview: interviewSchema })
export const noteResultSchema = z.object({ note: applicantNoteSchema })

export const hirePositionsSchema = z.object({
	positions: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			nameAr: z.string().nullable(),
			area: z.string().nullable(),
		}),
	),
})
export type HirePosition = z.infer<
	typeof hirePositionsSchema
>['positions'][number]

/**
 * A scope as the applicant screens see it (control-plane facts only): where an
 * interview happens (its time zone fixes what a typed time means) and which
 * currency a hire is paid in.
 */
export type ApplicantScope = {
	id: string
	/** Raw (possibly localized) name; pick the display string in the UI. */
	name: string
	timeZone: string
	currency: StaffingCurrency
}
