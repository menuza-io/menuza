import { and, ConfigFlag, db, eq, isNull } from '@repo/database'
import {
	CAPITAL_STYLES,
	DEFAULT_MENU_CARD_SETTINGS,
	type MenuCardSettingInput,
	type MenuCardSettings,
} from './menu-cards.ts'

/**
 * Review-card choices made once per organization (the capitals style), in
 * one organization-level ConfigFlag row, like "Translate new dishes".
 */
export const MENU_CARD_SETTINGS_FLAG = 'menu.review.settings'

function flagRow(organizationId: string) {
	return and(
		eq(ConfigFlag.key, MENU_CARD_SETTINGS_FLAG),
		eq(ConfigFlag.level, 'organization'),
		eq(ConfigFlag.organizationId, organizationId),
		isNull(ConfigFlag.userId),
	)
}

function parseSettings(value: unknown): MenuCardSettings {
	let raw: unknown = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			raw = null
		}
	}
	const object = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	const capitalStyle = (CAPITAL_STYLES as readonly unknown[]).includes(
		object.capitalStyle,
	)
		? (object.capitalStyle as MenuCardSettings['capitalStyle'])
		: null
	return { ...DEFAULT_MENU_CARD_SETTINGS, capitalStyle }
}

export async function getMenuCardSettings(
	organizationId: string,
): Promise<MenuCardSettings> {
	const [row] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(flagRow(organizationId))
		.limit(1)
	return parseSettings(row?.value)
}

export async function setMenuCardSetting(
	organizationId: string,
	input: MenuCardSettingInput,
): Promise<MenuCardSettings> {
	const next = { ...(await getMenuCardSettings(organizationId)) }
	if (input.key === 'capitalStyle') next.capitalStyle = input.value
	const value = next
	const updated = await db
		.update(ConfigFlag)
		.set({ value, updatedAt: new Date() })
		.where(flagRow(organizationId))
		.returning({ id: ConfigFlag.id })
	if (updated.length === 0) {
		await db
			.insert(ConfigFlag)
			.values({
				key: MENU_CARD_SETTINGS_FLAG,
				level: 'organization',
				organizationId,
				value,
			})
			.onConflictDoNothing()
	}
	return next
}
