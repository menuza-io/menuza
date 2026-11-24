import { ANNOUNCEMENT_AUDIENCES } from '@repo/staffing'
import { z } from 'zod'

/** Shapes returned by `/operator/staff/announcements`, parsed in the browser. */
export const announcementViewSchema = z.object({
	id: z.string(),
	title: z.string(),
	body: z.string(),
	audience: z.enum(ANNOUNCEMENT_AUDIENCES),
	audienceId: z.string().nullable(),
	startsAt: z.number(),
	expiresAt: z.number(),
	createdAt: z.number(),
	withdrawnAt: z.number().nullable(),
	state: z.enum(['live', 'scheduled', 'expired', 'withdrawn']),
	recipients: z.number(),
	read: z.number(),
})
export type AnnouncementRow = z.infer<typeof announcementViewSchema>

export const announcementListSchema = z.object({
	announcements: z.array(announcementViewSchema),
})

export const announcementDetailSchema = z.object({
	announcement: announcementViewSchema,
	recipients: z.array(
		z.object({
			staffId: z.string(),
			firstName: z.string(),
			lastName: z.string(),
			readAt: z.number().nullable(),
			source: z.enum(['schedule', 'station']).nullable(),
		}),
	),
})
export type AnnouncementDetail = z.infer<typeof announcementDetailSchema>

export const announcementResultSchema = z.object({
	announcement: announcementViewSchema,
})

/** The end of a chosen day in the browser's own time zone, as epoch milliseconds. */
export function endOfLocalDay(date: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
	const ms = new Date(`${date}T23:59:59`).getTime()
	return Number.isFinite(ms) ? ms : null
}
