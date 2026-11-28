import { z } from 'zod'

/**
 * What the App answers about a setup reminder (#271): words and counts only,
 * never an address. Used by Admin's Launch card for the preview and the manual
 * send.
 */
const exclusion = z.enum(['inactive', 'cancelled', 'test'])

export const setupReminderAnswerSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		subject: z.string(),
		heading: z.string(),
		intro: z.string(),
		progress: z.string(),
		actionLabel: z.string(),
		locale: z.enum(['en', 'ar']),
		recipients: z.number().int(),
		nextManualAt: z.string().nullable(),
	}),
	z.object({ status: z.literal('sent'), recipients: z.number().int() }),
	z.object({ status: z.literal('limit'), nextAt: z.string() }),
	z.object({ status: z.literal('nobody_to_notify') }),
	z.object({ status: z.literal('excluded'), reason: exclusion }),
	z.object({ status: z.literal('checklist_off') }),
	z.object({ status: z.literal('live') }),
	z.object({ status: z.literal('nothing_to_remind') }),
	z.object({ status: z.literal('failed') }),
	z.object({ status: z.literal('unavailable') }),
])
export type SetupReminderAnswer = z.infer<typeof setupReminderAnswerSchema>

export type SetupReminderHistoryRow = {
	id: string
	kind: 'auto' | 'manual'
	day: number | null
	stepKey: string
	doneCount: number
	totalCount: number
	recipientCount: number
	sentAt: string
}
