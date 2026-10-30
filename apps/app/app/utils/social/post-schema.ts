import { z } from 'zod'
import { SOCIAL_MAX_MEDIA, SOCIAL_MAX_TEXT } from './platforms.ts'
import { fromLocalInputValue } from './time.ts'

/** A scheduled time must be at least this far ahead. */
const MIN_LEAD_MS = 60_000
const MAX_LEAD_MS = 366 * 24 * 60 * 60_000

function isTimeZone(value: string) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value })
		return true
	} catch {
		return false
	}
}

// Errors are codes, translated by `socialFormErrors`. `scheduledAt` is the
// wall-clock value of the `datetime-local` input, in `timeZone`.
export const SocialPostFormSchema = z
	.object({
		intent: z.enum(['draft', 'schedule', 'publish']),
		body: z.string().max(SOCIAL_MAX_TEXT, 'too_long').default(''),
		accountIds: z.array(z.string().max(64)).max(50).default([]),
		mediaIds: z
			.array(z.string().max(64))
			.max(SOCIAL_MAX_MEDIA, 'too_many_media')
			.default([]),
		scheduledAt: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u, 'schedule_required')
			.optional(),
		timeZone: z
			.string()
			.max(64)
			.refine(isTimeZone, 'schedule_required')
			.default('UTC'),
	})
	.superRefine((value, ctx) => {
		if (value.intent !== 'draft' && value.accountIds.length === 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['accountIds'],
				message: 'accounts_required',
			})
		}
		if (value.intent !== 'schedule') return
		if (!value.scheduledAt) {
			ctx.addIssue({
				code: 'custom',
				path: ['scheduledAt'],
				message: 'schedule_required',
			})
			return
		}
		const at = fromLocalInputValue(value.scheduledAt, value.timeZone)
		const lead = at.getTime() - Date.now()
		if (Number.isNaN(lead)) {
			ctx.addIssue({
				code: 'custom',
				path: ['scheduledAt'],
				message: 'schedule_required',
			})
		} else if (lead < MIN_LEAD_MS) {
			ctx.addIssue({
				code: 'custom',
				path: ['scheduledAt'],
				message: 'schedule_future',
			})
		} else if (lead > MAX_LEAD_MS) {
			ctx.addIssue({
				code: 'custom',
				path: ['scheduledAt'],
				message: 'schedule_too_far',
			})
		}
	})
