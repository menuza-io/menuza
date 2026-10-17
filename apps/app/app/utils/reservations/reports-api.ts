import { z } from 'zod'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const REPORTS_BASE = '/operator/reservations/reports'

export const REPORT_KINDS = [
	'summary',
	'no-shows',
	'cancellations',
	'turn-times',
	'waitlist',
	'pacing',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export type ReportRange = {
	locationId: string
	from: string
	to: string
	serviceId: string | null
}

const num = z.number().catch(0)
const nullableNum = z.number().nullable().catch(null)
const str = z.string().catch('')
const nullableStr = z.string().nullable().catch(null)

const partiesCovers = { parties: num, covers: num }
const serviceRef = { serviceId: nullableStr, name: nullableStr }

const envelope = {
	range: z
		.object({
			from: str,
			to: str,
			serviceId: nullableStr,
		})
		.catch({ from: '', to: '', serviceId: null }),
	services: z.array(z.object({ id: z.string(), name: z.string() })).catch([]),
}

const summarySchema = z.object({
	...envelope,
	totals: z.object(partiesCovers).catch({ parties: 0, covers: 0 }),
	byService: z.array(z.object({ ...serviceRef, ...partiesCovers })).catch([]),
	bySource: z.array(z.object({ channel: str, ...partiesCovers })).catch([]),
	byPartySize: z
		.array(z.object({ partySize: num, ...partiesCovers }))
		.catch([]),
	byStatus: z.array(z.object({ status: str, ...partiesCovers })).catch([]),
})

const rowBase = {
	reservationId: str,
	businessDate: str,
	time: str,
	service: nullableStr,
	partySize: num,
	channel: str,
}

const noShowsSchema = z.object({
	...envelope,
	total: num,
	covers: num,
	rate: num,
	byService: z.array(z.object({ ...serviceRef, ...partiesCovers })).catch([]),
	byPartySize: z
		.array(z.object({ partySize: num, ...partiesCovers }))
		.catch([]),
	rows: z.array(z.object(rowBase)).catch([]),
})

const cancellationsSchema = z.object({
	...envelope,
	total: num,
	late: num,
	regular: num,
	covers: num,
	byCancelledBy: z
		.array(z.object({ cancelledBy: str, ...partiesCovers }))
		.catch([]),
	rows: z
		.array(
			z.object({
				...rowBase,
				cancelledBy: nullableStr,
				late: z.boolean().catch(false),
				cancelledAt: nullableNum,
			}),
		)
		.catch([]),
})

const turnTimesSchema = z.object({
	...envelope,
	total: num,
	actualAvgMin: num,
	byPartySize: z
		.array(
			z.object({
				partySize: num,
				count: num,
				actualAvgMin: num,
				configuredMin: nullableNum,
				bookedAvgMin: num,
				varianceMin: nullableNum,
			}),
		)
		.catch([]),
	configured: z
		.array(
			z.object({
				serviceId: nullableStr,
				partyMin: num,
				partyMax: num,
				minutes: num,
			}),
		)
		.catch([]),
})

const waitlistSchema = z.object({
	...envelope,
	total: num,
	byOutcome: z.array(z.object({ outcome: str, ...partiesCovers })).catch([]),
	quotedAvgMin: nullableNum,
	actualAvgMin: nullableNum,
	rows: z
		.array(
			z.object({
				entryId: str,
				businessDate: str,
				joinedAt: num,
				partySize: num,
				channel: str,
				outcome: str,
				quotedMin: nullableNum,
				actualMin: nullableNum,
			}),
		)
		.catch([]),
})

const pacingSchema = z.object({
	...envelope,
	totals: z
		.object({ bookings: num, covers: num })
		.catch({ bookings: 0, covers: 0 }),
	byService: z
		.array(z.object({ ...serviceRef, bookings: num, covers: num }))
		.catch([]),
	slots: z
		.array(
			z.object({
				businessDate: str,
				time: str,
				service: nullableStr,
				bookings: num,
				covers: num,
				maxCovers: nullableNum,
				maxParties: nullableNum,
				overLimit: z.boolean().catch(false),
			}),
		)
		.catch([]),
	limits: z
		.array(
			z.object({
				service: nullableStr,
				fromMin: nullableNum,
				toMin: nullableNum,
				bucketMin: nullableNum,
				maxCovers: nullableNum,
				maxParties: nullableNum,
			}),
		)
		.catch([]),
})

export type SummaryReport = z.infer<typeof summarySchema>
export type NoShowsReport = z.infer<typeof noShowsSchema>
export type CancellationsReport = z.infer<typeof cancellationsSchema>
export type TurnTimesReport = z.infer<typeof turnTimesSchema>
export type WaitlistReport = z.infer<typeof waitlistSchema>
export type PacingReport = z.infer<typeof pacingSchema>

export type ReportByKind = {
	summary: SummaryReport
	'no-shows': NoShowsReport
	cancellations: CancellationsReport
	'turn-times': TurnTimesReport
	waitlist: WaitlistReport
	pacing: PacingReport
}

const SCHEMAS = {
	summary: summarySchema,
	'no-shows': noShowsSchema,
	cancellations: cancellationsSchema,
	'turn-times': turnTimesSchema,
	waitlist: waitlistSchema,
	pacing: pacingSchema,
} as const

export async function fetchReport<K extends ReportKind>(
	client: ReservationsScopedClient,
	kind: K,
	params: {
		locationId: string
		from?: string
		to?: string
		serviceId?: string
	},
	signal?: AbortSignal,
): Promise<ReportByKind[K]> {
	const raw = await client.request<unknown>(`${REPORTS_BASE}/${kind}`, {
		query: {
			locationId: params.locationId,
			from: params.from || undefined,
			to: params.to || undefined,
			serviceId: params.serviceId || undefined,
		},
		signal,
	})
	return SCHEMAS[kind].parse(raw) as ReportByKind[K]
}
