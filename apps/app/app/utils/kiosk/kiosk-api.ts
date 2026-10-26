import { KIOSK_IDENTIFY_MODES } from '@repo/staffing'
import {
	ClockApiError,
	ClockNetworkError,
	clockRequest,
	type ClockPunchBody,
} from '@repo/staffing/clock-client'
import {
	clockIdentifyResponseSchema,
	clockPunchResponseSchema,
	type KioskIdentifyView,
	type KioskPunchView,
} from '@repo/staffing/clock-flow'
import { z } from 'zod'

/**
 * Browser client for the public `/kiosk` routes on the regional node. The
 * device secret is the only credential; a response carries a first name and a
 * clock state, never a surname, contact detail, pay figure or PIN. Nothing in
 * this file goes through the App's servers.
 */

const kioskConfigSchema = z.object({
	device: z.object({
		id: z.string(),
		name: z.string(),
		scopeId: z.string(),
		identifyMode: z.enum(KIOSK_IDENTIFY_MODES),
		showNextShifts: z.boolean(),
	}),
	scope: z.object({
		name: z.string().nullable(),
		timeZone: z.string().nullable(),
	}),
	serverNow: z.number(),
})
export type KioskConfigView = z.infer<typeof kioskConfigSchema>

const pairResponseSchema = kioskConfigSchema.extend({
	deviceSecret: z.string().min(20),
})

const identifyResponseSchema = clockIdentifyResponseSchema
const punchResponseSchema = clockPunchResponseSchema
export type { KioskIdentifyView, KioskPunchView }

const peopleResponseSchema = z.object({
	people: z.array(
		z.object({
			staffId: z.string(),
			firstName: z.string(),
			lastInitial: z.string(),
		}),
	),
})
export type KioskPersonView = z.infer<
	typeof peopleResponseSchema
>['people'][number]

export type KioskPunchBody = ClockPunchBody
export {
	ClockApiError as KioskApiError,
	ClockNetworkError as KioskNetworkError,
}

export type KioskApiOptions = {
	tenantApiUrl: string
	deviceSecret?: string
	fetchImpl?: typeof fetch
	/** Give up on a request after this long (a hung connection looks offline). */
	timeoutMs?: number
}

export function createKioskApi(options: KioskApiOptions) {
	const {
		tenantApiUrl,
		deviceSecret,
		fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
		timeoutMs = 8000,
	} = options
	const base = tenantApiUrl.replace(/\/+$/, '')

	function call<S extends z.ZodTypeAny>(
		path: string,
		schema: S,
		init: { method?: string; json?: unknown; secret?: string } = {},
	): Promise<z.infer<S>> {
		return clockRequest(
			{
				baseUrl: `${base}/kiosk`,
				deviceSecret,
				fetchImpl,
				timeoutMs,
				// Answers name people: never keep them in the browser's disk cache.
				requestInit: { cache: 'no-store' },
			},
			path,
			schema,
			init,
		)
	}

	return {
		pair: (code: string) =>
			call('/pair', pairResponseSchema, { method: 'POST', json: { code } }),
		config: () => call('/config', kioskConfigSchema),
		people: () => call('/people', peopleResponseSchema),
		identify: (pin: string, staffId?: string) =>
			call('/identify', identifyResponseSchema, {
				method: 'POST',
				json: { pin, ...(staffId ? { staffId } : {}) },
			}),
		punch: (request: KioskPunchBody) =>
			call('/punch', punchResponseSchema, { method: 'POST', json: request }),
	}
}

export type KioskApi = ReturnType<typeof createKioskApi>
