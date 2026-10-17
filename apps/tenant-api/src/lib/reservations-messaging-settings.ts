import { z } from 'zod'

/**
 * Guest message kinds an operator can switch on or off per location. Payment
 * kinds are not here: they follow the payment flow, not a message setting.
 */
export const TOGGLEABLE_MESSAGE_KINDS = [
	'confirmation',
	'modification',
	'cancellation_guest',
	'cancellation_restaurant',
	'reminder',
	'reconfirm_request',
	'request_received',
	'request_approved',
	'request_declined',
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
] as const

export type ToggleableMessageKind = (typeof TOGGLEABLE_MESSAGE_KINDS)[number]

export const WAITLIST_MESSAGE_KINDS: ReadonlySet<string> = new Set([
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
])

export const DEFAULT_REMINDER_HOURS = 24
export const DEFAULT_RECONFIRM_HOURS = 48
export const DEFAULT_QUIET_START_MIN = 21 * 60
export const DEFAULT_QUIET_END_MIN = 8 * 60

const kindShape = Object.fromEntries(
	TOGGLEABLE_MESSAGE_KINDS.map((kind) => [kind, z.boolean().optional()]),
) as Record<ToggleableMessageKind, z.ZodOptional<z.ZodBoolean>>

const minuteOfDay = z.number().int().min(0).max(1439)

/** What an operator may store in `rsv_location_settings.messaging`. */
export const messagingSettingsSchema = z.strictObject({
	kinds: z.strictObject(kindShape).optional(),
	reminderHours: z.number().int().min(1).max(168).optional(),
	reconfirmEnabled: z.boolean().optional(),
	reconfirmHours: z.number().int().min(1).max(168).optional(),
	quietHours: z
		.strictObject({ startMin: minuteOfDay, endMin: minuteOfDay })
		.optional(),
	smsEnabled: z.boolean().optional(),
})

export type MessagingSettingsInput = z.infer<typeof messagingSettingsSchema>

export type ResolvedMessagingSettings = {
	kinds: Record<ToggleableMessageKind, boolean>
	reminderHours: number
	reconfirmEnabled: boolean
	reconfirmHours: number
	quietHours: { startMin: number; endMin: number }
	smsEnabled: boolean
}

/** Stored values that no longer parse fall back to defaults instead of failing a send. */
export function resolveMessagingSettings(
	raw: unknown,
): ResolvedMessagingSettings {
	const parsed = messagingSettingsSchema.safeParse(raw ?? {})
	const value: MessagingSettingsInput = parsed.success ? parsed.data : {}
	const kinds = {} as Record<ToggleableMessageKind, boolean>
	for (const kind of TOGGLEABLE_MESSAGE_KINDS) {
		const stored = value.kinds?.[kind]
		// Reconfirmation is opt-in; every other kind is on until switched off.
		kinds[kind] = stored ?? (kind === 'reconfirm_request' ? false : true)
	}
	const reconfirmEnabled = value.reconfirmEnabled ?? kinds.reconfirm_request
	kinds.reconfirm_request = reconfirmEnabled
	return {
		kinds,
		reminderHours: value.reminderHours ?? DEFAULT_REMINDER_HOURS,
		reconfirmEnabled,
		reconfirmHours: value.reconfirmHours ?? DEFAULT_RECONFIRM_HOURS,
		quietHours: value.quietHours ?? {
			startMin: DEFAULT_QUIET_START_MIN,
			endMin: DEFAULT_QUIET_END_MIN,
		},
		smsEnabled: value.smsEnabled ?? true,
	}
}

export function isToggleableKind(kind: string): kind is ToggleableMessageKind {
	return (TOGGLEABLE_MESSAGE_KINDS as readonly string[]).includes(kind)
}
