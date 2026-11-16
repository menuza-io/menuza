import {
	defaultGiftCardSettings,
	giftCardSettingsSchema,
	readGiftCardSettings,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import { db, eq, GiftCardSettings as GiftCardSettingsTable } from '@repo/database'

/**
 * The organization's gift card settings (control plane, settings only). An
 * organization with no row, or an unreadable one, uses the defaults: presets,
 * bounds, no expiry, the Classic design, and the purchase limits that keep a
 * stolen payment card from becoming spendable money.
 */
export async function loadGiftCardSettings(
	organizationId: string,
): Promise<GiftCardSettings> {
	const row = await db
		.select({ settings: GiftCardSettingsTable.settings })
		.from(GiftCardSettingsTable)
		.where(eq(GiftCardSettingsTable.organizationId, organizationId))
		.get()
	if (!row) return defaultGiftCardSettings()
	try {
		return readGiftCardSettings(JSON.parse(row.settings))
	} catch {
		return defaultGiftCardSettings()
	}
}

export type SaveSettingsResult =
	{ ok: true; settings: GiftCardSettings } | { ok: false; error: string }

/**
 * Saves settings after the same checks the region applies: the bounds must
 * make sense, presets fall inside them, and the limits can never exceed the
 * largest card. Never writes anything about a card or a person.
 */
export async function saveGiftCardSettings(input: {
	organizationId: string
	userId: string
	settings: unknown
}): Promise<SaveSettingsResult> {
	const parsed = giftCardSettingsSchema.safeParse(input.settings)
	if (!parsed.success) return { ok: false, error: 'invalid_settings' }
	const settings = parsed.data
	if (settings.minAmountMinor > settings.maxAmountMinor) {
		return { ok: false, error: 'min_above_max' }
	}
	if (
		settings.presetsMinor.some(
			(preset) =>
				preset < settings.minAmountMinor || preset > settings.maxAmountMinor,
		)
	) {
		return { ok: false, error: 'preset_out_of_range' }
	}
	if (new Set(settings.presetsMinor).size !== settings.presetsMinor.length) {
		return { ok: false, error: 'duplicate_preset' }
	}
	if (!settings.designs.some((design) => design.enabled)) {
		return { ok: false, error: 'no_design' }
	}
	if (
		settings.designs.some(
			(design) => design.key === 'custom' && design.enabled && !design.imageKey,
		)
	) {
		return { ok: false, error: 'custom_design_needs_image' }
	}
	if (settings.limits.maxPerPurchaseMajor > settings.limits.maxCardMajor) {
		return { ok: false, error: 'purchase_above_card' }
	}
	const normalized = readGiftCardSettings(settings)
	const value = JSON.stringify(normalized)
	await db
		.insert(GiftCardSettingsTable)
		.values({
			organizationId: input.organizationId,
			settings: value,
			updatedById: input.userId,
		})
		.onConflictDoUpdate({
			target: GiftCardSettingsTable.organizationId,
			set: { settings: value, updatedById: input.userId, updatedAt: new Date() },
		})
	return { ok: true, settings: normalized }
}
