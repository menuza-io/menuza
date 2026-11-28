import { z } from 'zod'

/**
 * Guest order problem reports and how they are settled (#191). Shared by
 * tenant-api (`POST /orders/:id/problems`, `/operator/orders/problems*`),
 * Sites (the order page form), App (Orders, Problems) and reports.
 *
 * All report content (notes, photos, replies) is guest data and stays in the
 * region; the App only receives a generic "new report" event.
 */

export const ORDER_PROBLEMS_FLAG = 'ordering.problem_reports'

export const ORDER_PROBLEM_KINDS = [
	'missing_item',
	'wrong_item',
	'late',
	'quality',
	'other',
] as const
export type OrderProblemKind = (typeof ORDER_PROBLEM_KINDS)[number]

/** Kinds that name dishes: the form asks which items are affected. */
export const ORDER_PROBLEM_ITEM_KINDS: readonly OrderProblemKind[] = [
	'missing_item',
	'wrong_item',
	'quality',
]

export const ORDER_PROBLEM_STATUSES = ['open', 'answered', 'closed'] as const
export type OrderProblemStatus = (typeof ORDER_PROBLEM_STATUSES)[number]

export const ORDER_PROBLEM_RESOLUTIONS = [
	'refund',
	'credit',
	'reply',
	'closed',
] as const
export type OrderProblemResolution = (typeof ORDER_PROBLEM_RESOLUTIONS)[number]

/** Accepted for 48 hours after the order was completed. */
export const ORDER_PROBLEM_WINDOW_MS = 48 * 60 * 60 * 1000
/** An open report unanswered this long joins "Needs attention". */
export const ORDER_PROBLEM_UNANSWERED_MS = 24 * 60 * 60 * 1000
export const ORDER_PROBLEM_NOTE_MAX = 1000
export const ORDER_PROBLEM_MESSAGE_MAX = 1000
export const ORDER_PROBLEM_MAX_ITEMS = 50
export const ORDER_PROBLEM_MAX_REPLIES = 100
export const ORDER_PROBLEM_PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const ORDER_PROBLEM_PHOTO_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
] as const
export type OrderProblemPhotoType = (typeof ORDER_PROBLEM_PHOTO_TYPES)[number]
/** Credit codes work for this long unless the operator chooses fewer days. */
export const ORDER_PROBLEM_CREDIT_DEFAULT_DAYS = 60
export const ORDER_PROBLEM_CREDIT_MAX_DAYS = 365

export const ORDER_PROBLEM_ERROR_CODES = [
	'problem_not_found',
	'problem_window_closed',
	'order_not_reportable',
	'problem_closed',
	'problem_too_long',
	'invalid_item_ref',
	'photo_invalid',
	'photo_too_large',
	'photo_unavailable',
	'problem_already_answered',
	'refund_not_allowed',
	'credit_not_allowed',
] as const
export type OrderProblemErrorCode = (typeof ORDER_PROBLEM_ERROR_CODES)[number]

export const ORDER_PROBLEM_AUTHOR_KINDS = [
	'guest',
	'operator',
	'system',
] as const
export type OrderProblemAuthorKind = (typeof ORDER_PROBLEM_AUTHOR_KINDS)[number]

/** What an entry on the thread is. */
export const ORDER_PROBLEM_ENTRY_KINDS = [
	'report',
	'addition',
	'reply',
	'refund',
	'credit',
	'close',
] as const
export type OrderProblemEntryKind = (typeof ORDER_PROBLEM_ENTRY_KINDS)[number]

const noteSchema = z.string().trim().max(ORDER_PROBLEM_NOTE_MAX)
const messageSchema = z.string().trim().min(1).max(ORDER_PROBLEM_MESSAGE_MAX)

/** One affected line of the order: its position in `lines` and how many units. */
export const orderProblemItemRefSchema = z.strictObject({
	lineIndex: z.number().int().min(0).max(1000),
	quantity: z.number().int().min(1).max(1000).optional(),
})
export type OrderProblemItemRef = z.infer<typeof orderProblemItemRefSchema>

/** The JSON part of `POST /orders/:id/problems` (the photo rides beside it). */
export const submitOrderProblemSchema = z.strictObject({
	kind: z.enum(ORDER_PROBLEM_KINDS),
	items: z
		.array(orderProblemItemRefSchema)
		.max(ORDER_PROBLEM_MAX_ITEMS)
		.default([]),
	note: noteSchema.optional(),
})
export type SubmitOrderProblemRequest = z.infer<typeof submitOrderProblemSchema>

/** The operator's one-tap answers. A message is shown to the guest. */
export const answerOrderProblemSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('refund'),
		/** Minor units; absent refunds the affected items. */
		amountCents: z.number().int().min(1).max(1_000_000_000).optional(),
		message: messageSchema.optional(),
	}),
	z.strictObject({
		action: z.literal('credit'),
		/** Minor units; absent is the affected items' value. */
		amountCents: z.number().int().min(1).max(1_000_000_000).optional(),
		validDays: z
			.number()
			.int()
			.min(1)
			.max(ORDER_PROBLEM_CREDIT_MAX_DAYS)
			.optional(),
		message: messageSchema.optional(),
	}),
	z.strictObject({ action: z.literal('reply'), message: messageSchema }),
	z.strictObject({
		action: z.literal('close'),
		message: messageSchema.optional(),
	}),
])
export type AnswerOrderProblemRequest = z.infer<typeof answerOrderProblemSchema>

/** The guest adds to their own open report (a second submission). */
export const orderProblemEntryView = z.object({
	id: z.string(),
	kind: z.enum(ORDER_PROBLEM_ENTRY_KINDS),
	author: z.enum(ORDER_PROBLEM_AUTHOR_KINDS),
	body: z.string().nullable(),
	at: z.number(),
})
export type OrderProblemEntry = z.infer<typeof orderProblemEntryView>

/** Whether an order's report window is open at `now` (epoch ms). */
export function problemWindowOpen(
	completedAtMs: number | null,
	now: number,
): boolean {
	if (completedAtMs == null) return true
	return now - completedAtMs <= ORDER_PROBLEM_WINDOW_MS
}

/** An open report that waited longer than 24 hours for an answer. */
export function problemUnanswered(
	problem: { status: OrderProblemStatus; createdAt: number },
	now: number,
): boolean {
	return (
		problem.status === 'open' &&
		now - problem.createdAt >= ORDER_PROBLEM_UNANSWERED_MS
	)
}

export function isPhotoType(value: string): value is OrderProblemPhotoType {
	return (ORDER_PROBLEM_PHOTO_TYPES as readonly string[]).includes(value)
}

/**
 * The value of the affected items in minor units: each referenced line's total
 * share for the units named (the whole line when none). Pure; the region uses
 * it for "Refund the affected items" and the credit's default amount.
 */
export function affectedItemsCents(
	lines: readonly { totalCents: number; quantity: number }[],
	items: readonly { lineIndex: number; quantity?: number }[],
): number {
	let total = 0
	const seen = new Set<number>()
	for (const item of items) {
		if (seen.has(item.lineIndex)) continue
		seen.add(item.lineIndex)
		const line = lines[item.lineIndex]
		if (!line || line.quantity < 1) continue
		const units = Math.min(item.quantity ?? line.quantity, line.quantity)
		total += Math.round((line.totalCents * units) / line.quantity)
	}
	return total
}
