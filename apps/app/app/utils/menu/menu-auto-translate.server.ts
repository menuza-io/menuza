import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { and, ConfigFlag, db, eq, isNull } from '@repo/database'
import { withTimeout } from '#app/utils/phone-agent/faq-generate.server.ts'
import {
	isTranslationConfigured,
	translateTexts,
} from '#app/utils/translate.server.ts'
import {
	MENU_SUGGESTION_LIMITS,
	sanitizeSuggestionText,
	type MenuTextChange,
} from './menu-suggestions.ts'
import { updateMenuItemText } from './menu-updates.server.ts'

/**
 * "Translate new dishes automatically", an organization-level ConfigFlag row
 * (the organization settings store that needs no migration; it also shows
 * in Admin's feature flags). Only a literal `true` counts.
 */
export const MENU_AUTO_TRANSLATE_FLAG = 'menu.auto_translate'

/** A new dish waits this long for its translation before it is saved without. */
export const AUTO_TRANSLATE_TIMEOUT_MS = 8_000

function flagRow(organizationId: string) {
	return and(
		eq(ConfigFlag.key, MENU_AUTO_TRANSLATE_FLAG),
		eq(ConfigFlag.level, 'organization'),
		eq(ConfigFlag.organizationId, organizationId),
		isNull(ConfigFlag.userId),
	)
}

export async function getMenuAutoTranslate(
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(flagRow(organizationId))
		.limit(1)
	return row?.value === true
}

export async function setMenuAutoTranslate(
	organizationId: string,
	enabled: boolean,
): Promise<void> {
	const updated = await db
		.update(ConfigFlag)
		.set({ value: enabled, updatedAt: new Date() })
		.where(flagRow(organizationId))
		.returning({ id: ConfigFlag.id })
	if (updated.length === 0) {
		await db
			.insert(ConfigFlag)
			.values({
				key: MENU_AUTO_TRANSLATE_FLAG,
				level: 'organization',
				organizationId,
				value: enabled,
			})
			.onConflictDoNothing()
	}
}

/**
 * Translate a dish that was just created into the menu's other languages,
 * when the organization turned that on. Fills only what is empty, never
 * fails the create (the dish is already saved), and gives up after a few
 * seconds. Callers have already checked menu write access.
 */
export async function autoTranslateNewItem(
	input: {
		organization: {
			id: string
			slug: string
			siteLocales: string | null
			siteDefaultLocale: string | null
		}
		userId: string
		request?: Request
		itemId: string
		/** The values just saved (localized JSON or plain text). */
		displayName: string
		description: string | null
	},
	deps: {
		translate?: typeof translateTexts
		configured?: () => boolean
	} = {},
): Promise<'translated' | 'skipped' | 'failed'> {
	const translate = deps.translate ?? translateTexts
	const configured = deps.configured ?? isTranslationConfigured
	try {
		const { locales, defaultLocale } = parseSiteLocalesConfig(
			input.organization.siteLocales,
			input.organization.siteDefaultLocale,
		)
		const translationLocales = locales.filter(
			(locale) => locale !== defaultLocale,
		)
		if (translationLocales.length === 0 || !configured()) return 'skipped'
		if (!(await getMenuAutoTranslate(input.organization.id))) return 'skipped'

		const name = parseLocalizedString(input.displayName, defaultLocale)
		const description = parseLocalizedString(input.description, defaultLocale)
		const sourceName = name[defaultLocale]?.trim()
		const sourceDescription = description[defaultLocale]?.trim()
		if (!sourceName) return 'skipped'

		const changes: MenuTextChange[] = []
		for (const locale of translationLocales) {
			const texts: string[] = []
			const fields: Array<'displayName' | 'description'> = []
			if (!name[locale]?.trim()) {
				texts.push(sourceName)
				fields.push('displayName')
			}
			if (sourceDescription && !description[locale]?.trim()) {
				texts.push(sourceDescription)
				fields.push('description')
			}
			if (texts.length === 0) continue
			const translated = await withTimeout(
				translate({
					texts,
					sourceLang: defaultLocale,
					targetLang: locale,
					format: 'text',
				}),
				AUTO_TRANSLATE_TIMEOUT_MS,
			)
			fields.forEach((field, index) => {
				const value = sanitizeSuggestionText(
					translated[index],
					field === 'displayName'
						? MENU_SUGGESTION_LIMITS.name
						: MENU_SUGGESTION_LIMITS.description,
				)
				if (value) changes.push({ field, locale, value })
			})
		}
		if (changes.length === 0) return 'skipped'
		await updateMenuItemText({
			organization: input.organization,
			userId: input.userId,
			request: input.request,
			itemId: input.itemId,
			changes,
			defaultLocale,
			reason: 'auto_translate',
		})
		return 'translated'
	} catch (error) {
		console.error('Auto-translate of a new dish failed:', error)
		return 'failed'
	}
}

export type MenuReviewSettings = {
	/** `update:menu:any`: the stack and the toggle are shown only then. */
	canEdit: boolean
	/** The menu's languages other than its own (empty: no translations). */
	translationLocales: SiteContentLocale[]
	autoTranslate: boolean
}

/** What the Menu overview needs to offer Review suggestions. */
export async function loadMenuReviewSettings(
	organization: {
		id: string
		siteLocales: string | null
		siteDefaultLocale: string | null
	},
	userId: string,
): Promise<MenuReviewSettings> {
	const canEdit = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	if (!canEdit) {
		return { canEdit: false, translationLocales: [], autoTranslate: false }
	}
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const translationLocales = locales.filter(
		(locale) => locale !== defaultLocale,
	)
	return {
		canEdit,
		translationLocales,
		autoTranslate:
			translationLocales.length > 0
				? await getMenuAutoTranslate(organization.id)
				: false,
	}
}
