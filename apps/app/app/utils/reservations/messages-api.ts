import { z } from 'zod'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const MESSAGE_TEXTS_PATH = '/operator/reservations/setup/message-texts'

/** Kinds an operator can switch on or off, in display order. */
export const MESSAGE_SETTING_KINDS = [
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
export type MessageSettingKind = (typeof MESSAGE_SETTING_KINDS)[number]

export const WAITLIST_MESSAGE_SETTING_KINDS: ReadonlySet<string> = new Set([
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
])

export const DEFAULT_NOTE_MAX_LENGTH = 500

/** Custom note per language: only languages that have one are present. */
const notesSchema = z.record(z.string(), z.string())

const kindEntrySchema = z.object({
	kind: z.string(),
	enabled: z.boolean(),
	waitlist: z.boolean().default(false),
	notes: notesSchema.default({}),
})

const messagingSchema = z.object({
	kinds: z.record(z.string(), z.boolean()).default({}),
	reminderHours: z.number().int(),
	reconfirmEnabled: z.boolean(),
	reconfirmHours: z.number().int(),
	quietHours: z.object({
		startMin: z.number().int(),
		endMin: z.number().int(),
	}),
	smsEnabled: z.boolean(),
})

export const messageSettingsSchema = z.object({
	locationId: z.string(),
	version: z.number().int(),
	messaging: messagingSchema,
	kinds: z.array(kindEntrySchema),
	noteMaxLength: z.number().int().positive().default(DEFAULT_NOTE_MAX_LENGTH),
})
export type MessageSettings = z.infer<typeof messageSettingsSchema>
export type MessageKindEntry = z.infer<typeof kindEntrySchema>

export const messagePreviewSchema = z.object({
	kind: z.string(),
	locale: z.string(),
	subject: z.string(),
	html: z.string(),
	text: z.string().default(''),
	sms: z.string().nullable().default(null),
})
export type MessagePreview = z.infer<typeof messagePreviewSchema>

export type MessageSettingsPatch = {
	expectedVersion: number
	messaging?: {
		kinds?: Record<string, boolean>
		reminderHours?: number
		reconfirmEnabled?: boolean
		reconfirmHours?: number
		quietHours?: { startMin: number; endMin: number }
		smsEnabled?: boolean
	}
	texts?: Array<{ kind: string; locale: string; customNote: string }>
}

export async function fetchMessageSettings(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<MessageSettings> {
	const raw = await client.request<unknown>(MESSAGE_TEXTS_PATH, {
		query: { locationId },
		signal,
	})
	return messageSettingsSchema.parse(raw)
}

export async function saveMessageSettings(
	client: ReservationsScopedClient,
	locationId: string,
	patch: MessageSettingsPatch,
): Promise<MessageSettings> {
	const raw = await client.request<unknown>(MESSAGE_TEXTS_PATH, {
		method: 'PUT',
		body: { locationId, ...patch },
	})
	return messageSettingsSchema.parse(raw)
}

/** Sample data rendered by tenant-api from the saved settings (never the unsaved draft). */
export async function fetchMessagePreview(
	client: ReservationsScopedClient,
	locationId: string,
	input: { kind: string; locale: string },
	signal?: AbortSignal,
): Promise<MessagePreview> {
	const raw = await client.request<unknown>(`${MESSAGE_TEXTS_PATH}/preview`, {
		query: { locationId, kind: input.kind, locale: input.locale },
		signal,
	})
	return messagePreviewSchema.parse(raw)
}

/**
 * The settings sent back with a 409 `stale_version`, so the screen can adopt the
 * newer copy without another round trip. Null when the body has no usable copy.
 */
export function settingsFromConflict(err: unknown): MessageSettings | null {
	if (!err || typeof err !== 'object') return null
	const body = (err as { body?: unknown }).body
	if (!body || typeof body !== 'object') return null
	const details = body as { current?: unknown; settings?: unknown }
	const parsed = messageSettingsSchema.safeParse(
		details.current ?? details.settings,
	)
	return parsed.success ? parsed.data : null
}
