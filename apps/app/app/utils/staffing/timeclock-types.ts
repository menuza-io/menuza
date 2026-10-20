import { KIOSK_IDENTIFY_MODES, laborPolicyBaseSchema } from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/timeclock`, parsed in the browser. They mirror
 * the serializers in `apps/tenant-api/src/services/labor-policy-service.ts`,
 * `kiosk-device-service.ts` and `timeclock-today-service.ts`.
 */

export const laborPolicyViewSchema = laborPolicyBaseSchema.extend({
	id: z.string().nullable(),
	/** `null` is the organization default. */
	scopeId: z.string().nullable(),
	source: z.enum(['scope', 'default', 'builtin']),
	version: z.number().int(),
	updatedAt: z.number().nullable(),
	aggregateDecisionRequired: z.boolean(),
})
export type LaborPolicyViewRow = z.infer<typeof laborPolicyViewSchema>

/** `GET /policies/default` answers `{ policy: null }` until one is saved. */
export const defaultPolicyResponseSchema = z.object({
	policy: laborPolicyViewSchema.nullable(),
})

export const kioskDeviceSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	name: z.string(),
	identifyMode: z.enum(KIOSK_IDENTIFY_MODES),
	showNextShifts: z.boolean(),
	pairedAt: z.number(),
	lastSeenAt: z.number().nullable(),
	revokedAt: z.number().nullable(),
	status: z.enum(['active', 'revoked']),
	backoffSeconds: z.number(),
	failuresLastHour: z.number(),
})
export type KioskDeviceRow = z.infer<typeof kioskDeviceSchema>

export const kioskDevicesResponseSchema = z.object({
	devices: z.array(kioskDeviceSchema),
})

export const pendingPairingCodeSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	deviceName: z.string(),
	identifyMode: z.enum(KIOSK_IDENTIFY_MODES),
	showNextShifts: z.boolean(),
	expiresAt: z.number(),
	createdAt: z.number(),
})
export type PendingPairingCodeRow = z.infer<typeof pendingPairingCodeSchema>

export const pendingCodesResponseSchema = z.object({
	codes: z.array(pendingPairingCodeSchema),
})

/** The plaintext code is returned once, at creation, and never again. */
export const createdPairingCodeSchema = z.object({
	id: z.string(),
	code: z.string(),
	expiresAt: z.number(),
	scopeId: z.string(),
	deviceName: z.string(),
	fragment: z.string(),
})
export type CreatedPairingCode = z.infer<typeof createdPairingCodeSchema>

export const todayRowSchema = z.object({
	entryId: z.string(),
	staffId: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	scopeId: z.string(),
	timeZone: z.string(),
	positionId: z.string().nullable(),
	positionName: z.string().nullable(),
	positionNameAr: z.string().nullable(),
	state: z.enum(['in', 'on_break']),
	clockInAt: z.number(),
	breakStartAt: z.number().nullable(),
	issues: z.array(z.string()),
	late: z.boolean(),
	missingClockOut: z.boolean(),
})
export type TodayRow = z.infer<typeof todayRowSchema>

export const todayRecentSchema = z.object({
	entryId: z.string(),
	staffId: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	scopeId: z.string(),
	timeZone: z.string(),
	clockInAt: z.number(),
	clockOutAt: z.number(),
	issues: z.array(z.string()),
	needsReview: z.boolean(),
})
export type TodayRecentRow = z.infer<typeof todayRecentSchema>

export const todayResponseSchema = z.object({
	serverNow: z.number(),
	present: z.array(todayRowSchema),
	recent: z.array(todayRecentSchema),
})
export type TodayResponse = z.infer<typeof todayResponseSchema>
