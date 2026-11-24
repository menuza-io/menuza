import { z } from 'zod'
const idSchema = z.string().min(1).max(64)

/**
 * Announcements to staff (#486): a short notice for everyone, one position or
 * one scope. Staff see it on My schedule and on Station after their next punch
 * and tap "Got it"; the manager sees who did. Not a chat: there are no replies.
 * An announcement stops showing at its expiry; it is never deleted, so the
 * record of who read it stays.
 *
 * Plain text only. Nothing about a guest belongs in one: the words are the
 * manager's own, shown as text and never as HTML.
 */

export const ANNOUNCEMENT_AUDIENCES = ['everyone', 'position', 'scope'] as const
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number]

export const ANNOUNCEMENT_TITLE_MAX = 120
export const ANNOUNCEMENT_BODY_MAX = 2000
/** The longest an announcement may stay up. */
export const ANNOUNCEMENT_MAX_DAYS = 90
export const ANNOUNCEMENT_MAX_ACTIVE = 50

const text = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.refine((value) => /[\p{L}\p{N}]/u.test(value), 'Write something')

export const announcementCreateSchema = z
	.object({
		title: text(ANNOUNCEMENT_TITLE_MAX),
		body: text(ANNOUNCEMENT_BODY_MAX),
		audience: z.enum(ANNOUNCEMENT_AUDIENCES),
		/** A position id or a scope id, by `audience`; absent for everyone. */
		audienceId: idSchema.optional(),
		/** When it stops showing (epoch milliseconds): required. */
		expiresAt: z.number().int().positive(),
		/** When it starts showing; default now. */
		startsAt: z.number().int().positive().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.audience === 'everyone' && value.audienceId !== undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['audienceId'],
				message: 'Everyone has no audience id',
			})
		}
		if (value.audience !== 'everyone' && value.audienceId === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['audienceId'],
				message: 'Choose who it is for',
			})
		}
	})
export type AnnouncementCreate = z.infer<typeof announcementCreateSchema>

export const announcementListQuerySchema = z
	.object({
		includeExpired: z
			.enum(['true', 'false'])
			.default('false')
			.transform((value) => value === 'true'),
	})
	.strict()

/** What a manager sees of one announcement. */
export type AnnouncementView = {
	id: string
	title: string
	body: string
	audience: AnnouncementAudience
	audienceId: string | null
	startsAt: number
	expiresAt: number
	createdAt: number
	withdrawnAt: number | null
	/** `live`, `scheduled`, `expired` or `withdrawn`, judged at `serverNow`. */
	state: 'live' | 'scheduled' | 'expired' | 'withdrawn'
	/** People it is for (active staff in the audience) and how many tapped "Got it". */
	recipients: number
	read: number
}

export type AnnouncementRecipient = {
	staffId: string
	firstName: string
	lastName: string
	readAt: number | null
	source: 'schedule' | 'station' | null
}

export type AnnouncementDetailView = {
	announcement: AnnouncementView
	recipients: AnnouncementRecipient[]
}

/** What staff see: the words, when it stops, and whether they tapped "Got it". */
export type MyAnnouncement = {
	id: string
	title: string
	body: string
	expiresAt: number
	createdAt: number
	readAt: number | null
}

export type MyAnnouncementsView = {
	serverNow: number
	announcements: MyAnnouncement[]
}

export const ANNOUNCEMENT_ERROR_CODES = [
	'not_found',
	'expiry_in_the_past',
	'expiry_too_far',
	'starts_after_expiry',
	'unknown_position',
	'scope_out_of_scope',
	'unrestricted_scope_required',
	'too_many_active',
	'already_withdrawn',
] as const
export type AnnouncementErrorCode = (typeof ANNOUNCEMENT_ERROR_CODES)[number]

export const announcementReadSchema = z
	.object({ announcementId: idSchema })
	.strict()
