import { randomUUID } from 'node:crypto'
import {
	rsvLocationSettings,
	rsvMessageTexts,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import {
	isSiteContentLocale,
	SITE_CONTENT_LOCALES,
} from '@repo/common/site-locales'
import { LOCALE_KEY_PATTERN, resolveGuestLocale } from '@repo/reservations'
import { z } from 'zod'
import { badRequest, conflict } from '../lib/http.ts'
import { loadLocaleOrg } from '../lib/reservations-i18n.ts'
import { messageCopyFor } from '../lib/reservations-copy/index.ts'
import {
	isToggleableKind,
	messagingSettingsSchema,
	resolveMessagingSettings,
	TOGGLEABLE_MESSAGE_KINDS,
	WAITLIST_MESSAGE_KINDS,
	type MessagingSettingsInput,
	type ToggleableMessageKind,
} from '../lib/reservations-messaging-settings.ts'
import {
	normalizeReservationLocale,
	renderReservationEmail,
	type ReservationEmailLocale,
} from '../lib/reservations-email.ts'
import { renderReservationSms } from '../lib/reservations-sms.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { reconcileScheduledMessages } from './rsv-message-queue.ts'
import {
	ensureLocationSettingsRow,
	writeSetupAuditLog,
} from './rsv-setup-service.ts'

export const MESSAGE_NOTE_MAX_LENGTH = 500

function hasControlCharacters(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0)
		if (
			code === 0x7f ||
			(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
		) {
			return true
		}
	}
	return false
}

const noteText = z
	.string()
	.max(MESSAGE_NOTE_MAX_LENGTH)
	// Plain text only: markup is escaped when rendered, and control characters
	// have no business in a guest email.
	.refine((value) => !hasControlCharacters(value), {
		message: 'control_characters',
	})

const messagingPatchSchema = z.strictObject({
	kinds: messagingSettingsSchema.shape.kinds,
	reminderHours: messagingSettingsSchema.shape.reminderHours,
	reconfirmEnabled: messagingSettingsSchema.shape.reconfirmEnabled,
	reconfirmHours: messagingSettingsSchema.shape.reconfirmHours,
	quietHours: messagingSettingsSchema.shape.quietHours,
	smsEnabled: messagingSettingsSchema.shape.smsEnabled,
})

export const messageSettingsPatchSchema = z.strictObject({
	expectedVersion: z.number().int().min(1).optional(),
	messaging: messagingPatchSchema.optional(),
	texts: z
		.array(
			z.strictObject({
				kind: z.enum(TOGGLEABLE_MESSAGE_KINDS),
				locale: z.string().regex(LOCALE_KEY_PATTERN),
				customNote: noteText,
			}),
		)
		.max(TOGGLEABLE_MESSAGE_KINDS.length * SITE_CONTENT_LOCALES.length)
		.optional(),
})

export type MessageSettingsPatch = z.infer<typeof messageSettingsPatchSchema>

function storedMessaging(raw: unknown): MessagingSettingsInput {
	const parsed = messagingSettingsSchema.safeParse(raw ?? {})
	return parsed.success ? parsed.data : {}
}

export async function getMessageSettings(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
) {
	const row = await ensureLocationSettingsRow(db, orgId, locationId)
	return serialize(db, locationId, row.version, row.messaging)
}

async function serialize(
	db: TenantDatabase,
	locationId: string,
	version: number,
	rawMessaging: unknown,
) {
	const messaging = resolveMessagingSettings(rawMessaging)
	const rows = await db
		.select({
			kind: rsvMessageTexts.kind,
			locale: rsvMessageTexts.locale,
			customNote: rsvMessageTexts.customNote,
			updatedAt: rsvMessageTexts.updatedAt,
		})
		.from(rsvMessageTexts)
		.where(eq(rsvMessageTexts.locationId, locationId))
	return {
		locationId,
		version,
		messaging,
		kinds: TOGGLEABLE_MESSAGE_KINDS.map((kind) => ({
			kind,
			enabled: messaging.kinds[kind],
			waitlist: WAITLIST_MESSAGE_KINDS.has(kind),
			notes: Object.fromEntries(
				rows
					.filter((r) => r.kind === kind && r.customNote)
					.map((r) => [r.locale, r.customNote]),
			) as Record<string, string>,
		})),
		texts: rows.map((r) => ({
			kind: r.kind,
			locale: r.locale,
			customNote: r.customNote,
			updatedAt: r.updatedAt,
		})),
		noteMaxLength: MESSAGE_NOTE_MAX_LENGTH,
	}
}

export async function updateMessageSettings(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	actorId: string,
	patch: MessageSettingsPatch,
) {
	return withSetupWrite(
		db,
		async (tx) => {
			const current = await ensureLocationSettingsRow(tx, orgId, locationId)
			if (
				patch.expectedVersion !== undefined &&
				patch.expectedVersion !== current.version
			) {
				const settings = await serialize(
					tx,
					locationId,
					current.version,
					current.messaging,
				)
				throw conflict('stale_version', 'stale_version', {
					current: settings,
					settings,
					version: current.version,
				})
			}

			const now = Date.now()
			const changes: Record<string, unknown> = {}
			let nextMessaging: MessagingSettingsInput | null = null
			if (patch.messaging) {
				const stored = storedMessaging(current.messaging)
				const incoming = patch.messaging
				const kinds = { ...stored.kinds, ...incoming.kinds }
				// One source of truth for reconfirmation: the switch on its kind and
				// the standalone flag must never disagree in storage.
				if (incoming.reconfirmEnabled !== undefined) {
					kinds.reconfirm_request = incoming.reconfirmEnabled
				} else if (incoming.kinds?.reconfirm_request !== undefined) {
					incoming.reconfirmEnabled = incoming.kinds.reconfirm_request
				}
				const merged = messagingSettingsSchema.safeParse({
					...stored,
					...Object.fromEntries(
						Object.entries(incoming).filter(([, v]) => v !== undefined),
					),
					kinds,
				})
				if (!merged.success) {
					throw badRequest('invalid', 'invalid', {
						fields: ['messaging'],
						issues: merged.error.issues.map((issue) => ({
							path: issue.path.join('.'),
							code: issue.code,
						})),
					})
				}
				nextMessaging = merged.data
				changes.messaging = Object.keys(incoming)
			}

			if (patch.texts?.length) {
				const changed: string[] = []
				const localeOrg = await loadLocaleOrg(orgId)
				for (const text of patch.texts) {
					const enabled = localeOrg
						? localeOrg.locales.includes(text.locale)
						: isSiteContentLocale(text.locale)
					if (!enabled || !isSiteContentLocale(text.locale)) {
						throw badRequest('locale_not_enabled', undefined, {
							fields: ['texts'],
						})
					}
					const note = text.customNote.trim()
					const existing = await tx
						.select({ id: rsvMessageTexts.id })
						.from(rsvMessageTexts)
						.where(
							and(
								eq(rsvMessageTexts.locationId, locationId),
								eq(rsvMessageTexts.kind, text.kind),
								eq(rsvMessageTexts.locale, text.locale),
							),
						)
						.get()
					if (!note) {
						if (existing) {
							await tx
								.delete(rsvMessageTexts)
								.where(eq(rsvMessageTexts.id, existing.id))
						}
					} else if (existing) {
						await tx
							.update(rsvMessageTexts)
							.set({ customNote: note, updatedBy: actorId, updatedAt: now })
							.where(eq(rsvMessageTexts.id, existing.id))
					} else {
						await tx.insert(rsvMessageTexts).values({
							id: randomUUID(),
							locationId,
							kind: text.kind,
							locale: text.locale,
							customNote: note,
							updatedBy: actorId,
							updatedAt: now,
						})
					}
					changed.push(`${text.kind}:${text.locale}`)
				}
				// Text itself never goes in the audit row, only which slots changed.
				changes.texts = changed
			}

			const nextVersion = current.version + 1
			await tx
				.update(rsvLocationSettings)
				.set({
					...(nextMessaging ? { messaging: nextMessaging } : {}),
					version: nextVersion,
					updatedAt: now,
					updatedBy: actorId,
				})
				.where(eq(rsvLocationSettings.locationId, locationId))
			await writeSetupAuditLog(tx, {
				actorId,
				locationId,
				action: 'messaging.update',
				entityType: 'location_settings',
				entityId: locationId,
				changes: { version: nextVersion, ...changes },
			})

			if (nextMessaging) {
				// Reminder timing, switches and SMS consent decide which scheduled
				// rows exist, so every upcoming booking is brought in line.
				const upcoming = await tx
					.select({ businessDate: rsvReservations.businessDate })
					.from(rsvReservations)
					.where(
						and(
							eq(rsvReservations.locationId, locationId),
							gt(rsvReservations.startAt, now),
						),
					)
				const dates = [...new Set(upcoming.map((r) => r.businessDate))]
				await reconcileScheduledMessages(
					tx,
					{ orgId, now },
					{ locationId, dates },
				)
			}

			const row = await ensureLocationSettingsRow(tx, orgId, locationId)
			return serialize(tx, locationId, row.version, row.messaging)
		},
		orgId,
	)
}

const SAMPLE_START_MS = Date.UTC(2031, 5, 14, 19, 30)

/** Sample data only: a preview must never carry a real guest, booking or link. */
export async function previewMessage(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	input: { kind: string; locale: string; channel?: 'email' | 'sms' },
) {
	if (!isToggleableKind(input.kind)) {
		throw badRequest('invalid', 'invalid', {
			fields: ['kind'],
			issues: [{ path: 'kind', code: 'invalid_kind' }],
		})
	}
	const kind: ToggleableMessageKind = input.kind
	const context = await getReservationsContext(orgId)
	const locale: ReservationEmailLocale = normalizeReservationLocale(
		context
			? resolveGuestLocale(
					input.locale,
					context.organization.locales,
					context.organization.defaultLocale,
				)
			: input.locale,
	)
	const settings = await ensureLocationSettingsRow(db, orgId, locationId)
	const location = context?.locations.find((l) => l.id === locationId)
	const note = await db
		.select({ customNote: rsvMessageTexts.customNote })
		.from(rsvMessageTexts)
		.where(
			and(
				eq(rsvMessageTexts.locationId, locationId),
				eq(rsvMessageTexts.kind, kind),
				eq(rsvMessageTexts.locale, locale),
			),
		)
		.get()
	const orgWide = note
		? null
		: await db
				.select({ customNote: rsvMessageTexts.customNote })
				.from(rsvMessageTexts)
				.where(
					and(
						isNull(rsvMessageTexts.locationId),
						eq(rsvMessageTexts.kind, kind),
						eq(rsvMessageTexts.locale, locale),
					),
				)
				.get()
	const customNote = (note ?? orgWide)?.customNote?.trim() || null
	const copyLabels = messageCopyFor(locale).labels
	const restaurantName = location?.name ?? copyLabels.sampleRestaurant
	const sample = {
		kind,
		locale,
		restaurantName,
		address: location?.address?.formattedAddress ?? null,
		phone: location?.phone ?? null,
		firstName: copyLabels.sampleName,
		whenMs: SAMPLE_START_MS,
		timeZone: settings.timeZone,
		partySize: 4,
		manageUrl: 'https://example.com/manage#sample',
		statusUrl: 'https://example.com/waitlist#sample',
		bookUrl: 'https://example.com/reserve',
		calendarUrl: 'https://example.com/calendar#sample',
		quotedWaitMin: 20,
		customNote,
	}
	const email = renderReservationEmail({
		...sample,
		theme: context?.organization.emailTheme ?? DEFAULT_THEME,
	})
	return {
		kind,
		locale,
		sample: true,
		subject: email.subject,
		html: email.html,
		text: email.text,
		sms: renderReservationSms({
			kind,
			locale,
			restaurantName,
			whenMs: sample.whenMs,
			timeZone: sample.timeZone,
			partySize: sample.partySize,
			url: sample.manageUrl,
			quotedWaitMin: sample.quotedWaitMin,
		}),
	}
}

const DEFAULT_THEME = {
	organizationName: '',
	logoUrl: null,
	background: '#ffffff',
	card: '#ffffff',
	foreground: '#111827',
	mutedForeground: '#6b7280',
	border: '#e5e7eb',
	primary: '#111827',
	primaryForeground: '#ffffff',
	radius: 8,
	bodyFont: null,
	headingFont: null,
} as unknown as Parameters<typeof renderReservationEmail>[0]['theme']
