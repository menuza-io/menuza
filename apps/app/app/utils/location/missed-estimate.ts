import { type MissedPlan } from '@repo/common/missed-sales'
import { z } from 'zod'

/**
 * What the pause card and the Today line need to show the estimate of sales
 * missed while online ordering was paused (#176): per pause, the windows to
 * estimate (the pause cut to the open hours, with the earlier weeks it is
 * averaged over). Times only; the region adds up what it holds and the page
 * labels the result an estimate.
 */

const windowSchema = z.object({ from: z.number(), to: z.number() })

export const missedPlanEntrySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	locationName: z.string(),
	currency: z.string(),
	timeZone: z.string(),
	/** The pause is still in force. */
	current: z.boolean(),
	startedAt: z.number(),
	endedAt: z.number().nullable(),
	minutesPaused: z.number(),
	plans: z.array(
		z.object({
			from: z.number(),
			to: z.number(),
			weeks: z.array(windowSchema),
			weeksSkipped: z.number(),
			weekday: z.number(),
			localFrom: z.string(),
			localTo: z.string(),
		}),
	),
})
export type MissedPlanEntry = z.infer<typeof missedPlanEntrySchema>
export type { MissedPlan }

export const missedEstimateAnswerSchema = z.object({
	estimates: z.array(
		z.discriminatedUnion('enough', [
			z.object({
				id: z.string(),
				enough: z.literal(true),
				orders: z.number(),
				salesMinor: z.number(),
				weeksUsed: z.number(),
			}),
			z.object({
				id: z.string(),
				enough: z.literal(false),
				weeksUsed: z.number(),
			}),
		]),
	),
})
export type MissedEstimateAnswer = z.infer<
	typeof missedEstimateAnswerSchema
>['estimates'][number]

export type EntryEstimate =
	| {
			status: 'enough'
			orders: number
			salesMinor: number
			/** The fewest weeks any piece of the pause rests on. */
			weeksUsed: number
	  }
	| { status: 'not_enough' }

/**
 * One pause's estimate from the answers of its pieces: the sums of its pieces,
 * and "not enough history" as soon as any piece is.
 */
export function summarizeEntry(
	answers: readonly MissedEstimateAnswer[],
): EntryEstimate {
	if (answers.length === 0) return { status: 'not_enough' }
	let orders = 0
	let salesMinor = 0
	let weeksUsed = Number.POSITIVE_INFINITY
	for (const answer of answers) {
		if (!answer.enough) return { status: 'not_enough' }
		orders += answer.orders
		salesMinor += answer.salesMinor
		weeksUsed = Math.min(weeksUsed, answer.weeksUsed)
	}
	return { status: 'enough', orders, salesMinor, weeksUsed }
}

/** "1 h 40 min": the length of a pause, in the viewer's locale. */
export function formatPauseLength(minutes: number, locale: string): string {
	const rounded = Math.max(0, Math.round(minutes))
	const hours = Math.floor(rounded / 60)
	const rest = rounded % 60
	const unit = (value: number, name: 'hour' | 'minute') => {
		try {
			return new Intl.NumberFormat(locale, {
				style: 'unit',
				unit: name,
				unitDisplay: 'narrow',
			}).format(value)
		} catch {
			return `${value} ${name === 'hour' ? 'h' : 'min'}`
		}
	}
	const parts: string[] = []
	if (hours > 0) parts.push(unit(hours, 'hour'))
	if (rest > 0 || hours === 0) parts.push(unit(rest, 'minute'))
	return parts.join(' ')
}

/** The weekday of a plan (0 = Sunday) as a word in the viewer's locale. */
export function weekdayName(weekday: number, locale: string): string {
	// 2024-01-07 was a Sunday.
	const date = new Date(Date.UTC(2024, 0, 7 + weekday))
	try {
		return new Intl.DateTimeFormat(locale, {
			weekday: 'long',
			timeZone: 'UTC',
		}).format(date)
	} catch {
		return String(weekday)
	}
}
