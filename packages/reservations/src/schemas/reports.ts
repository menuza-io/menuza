import { z } from 'zod'
import { businessDateStringSchema } from './common.ts'

export const reportsQuerySchema = z.strictObject({
	locationId: z.string().trim().min(1),
	fromDate: businessDateStringSchema,
	toDate: businessDateStringSchema,
	serviceId: z.string().trim().min(1).optional(),
})

export const reportsSummaryResponseSchema = z.strictObject({
	locationId: z.string(),
	fromDate: businessDateStringSchema,
	toDate: businessDateStringSchema,
	totalCovers: z.number().int().min(0),
	totalParties: z.number().int().min(0),
	seatedCovers: z.number().int().min(0),
	cancelledParties: z.number().int().min(0),
	noShowParties: z.number().int().min(0),
	noShowRateBp: z.number().int().min(0).max(10_000),
	walkInCovers: z.number().int().min(0),
	onlineCovers: z.number().int().min(0),
	phoneCovers: z.number().int().min(0),
	voiceCovers: z.number().int().min(0),
	averageTurnMin: z.number().min(0),
	netDepositsMinor: z.number().int(),
	currency: z.string(),
})
