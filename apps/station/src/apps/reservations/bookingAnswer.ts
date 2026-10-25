/**
 * What the server's answer to a booking says: the confirmation code, the table
 * it was given, and whether the guest was texted. Each is told only if the
 * answer carries it (an older server sends less): the stand never claims a
 * table or a text it was not told about.
 */

export type BookingAnswer = {
	code: string | null
	/** "1", or "3 + 4": the table the booking got, when the answer says. */
	table: string | null
	/** The server says the guest was sent a confirmation text. */
	textSent: boolean
}

const text = (value: unknown) =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/** Keys a server may use to say a confirmation text went out (true only). */
const TEXT_SENT_KEYS = [
	'confirmationSent',
	'confirmationTextSent',
	'confirmationSmsSent',
	'smsSent',
]

export function bookingAnswerOf(
	result: unknown,
	/** The floor's tables, to name a table the answer gives only by id. */
	tables: Array<{ id: string; label: string }> = [],
): BookingAnswer {
	const top = (result ?? {}) as Record<string, unknown>
	const r = (top.reservation ?? {}) as Record<string, unknown>
	const labels = Array.isArray(r.tableLabels)
		? r.tableLabels.map(text).filter((label): label is string => label !== null)
		: []
	const named =
		labels.length > 0
			? labels
			: Array.isArray(r.tableIds)
				? r.tableIds
						.map((id) => tables.find((t) => t.id === id)?.label ?? null)
						.filter((label): label is string => label !== null)
				: []
	return {
		code: text(r.confirmationCode),
		table: named.length > 0 ? named.join(' + ') : null,
		textSent: TEXT_SENT_KEYS.some(
			(key) => top[key] === true || r[key] === true,
		),
	}
}
