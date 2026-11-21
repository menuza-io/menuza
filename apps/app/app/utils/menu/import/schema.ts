import { createId } from '@paralleldrive/cuid2'
import { serializeLocalizedString } from '@repo/common/site-locales'
import { z } from 'zod'

export const MENU_IMPORT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const MENU_IMPORT_FETCH_TIMEOUT_MS = 20_000 // 20 seconds
export const MENU_IMPORT_MAX_REDIRECTS = 5

export const MENU_IMPORT_NAME_MAX = 120
export const MENU_IMPORT_DESCRIPTION_MAX = 500
export const MENU_IMPORT_MAX_PRICE = 1_000_000

export const MENU_IMPORT_MAX_MENUS = 10
export const MENU_IMPORT_MAX_CATEGORIES = 60
export const MENU_IMPORT_MAX_ITEMS = 300
export const MENU_IMPORT_MAX_MODIFIER_GROUPS = 20
export const MENU_IMPORT_MAX_MODIFIER_OPTIONS = 50
export const MENU_IMPORT_MAX_SIZES = 20
export const MENU_IMPORT_MAX_IMAGE_SUGGESTIONS = 30

export const MENU_IMPORT_ALLOWED_IMAGE_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
] as const

export const MENU_IMPORT_ALLOWED_URL_CONTENT_TYPES = [
	'text/html',
	'application/xhtml+xml',
	'application/pdf',
] as const

export const MENU_IMPORT_ERROR_CODES = [
	'url_not_allowed',
	'fetch_failed',
	'unsupported_file',
	'nothing_found',
	'model_invalid',
	'extract_failed',
	'menu_import_disabled',
	'import_in_progress',
	'ownership_not_confirmed',
	'rate_limited',
	'invalid_draft',
	'apply_failed',
] as const

export type MenuImportErrorCode = (typeof MENU_IMPORT_ERROR_CODES)[number]

export const MENU_IMPORT_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type MenuImportConfidence =
	(typeof MENU_IMPORT_CONFIDENCE_LEVELS)[number]

export const MENU_IMPORT_LOW_CONFIDENCE_FIELDS = [
	'name',
	'description',
	'price',
	'sizes',
] as const
export type MenuImportLowConfidenceField =
	(typeof MENU_IMPORT_LOW_CONFIDENCE_FIELDS)[number]

export const MENU_IMPORT_MISSING_EXISTING_ACTIONS = [
	'keep',
	'mark_unavailable',
] as const
export type MenuImportMissingExistingAction =
	(typeof MENU_IMPORT_MISSING_EXISTING_ACTIONS)[number]

const trimmedOptionalText = (max: number) =>
	z
		.string()
		.transform((value) => value.trim())
		.pipe(z.string().max(max))
		.nullable()
		.optional()

const trimmedRequiredId = z
	.string()
	.transform((value) => value.trim())
	.pipe(z.string().min(1).max(80))

export type LocalizedImportText = {
	en?: string
	ar?: string
}

function cleanLocalizedOutput(value: {
	en?: string | null
	ar?: string | null
}): LocalizedImportText {
	const out: LocalizedImportText = {}
	if (value.en) out.en = value.en
	if (value.ar) out.ar = value.ar
	return out
}

export const localizedImportNameSchema = z
	.object({
		en: trimmedOptionalText(MENU_IMPORT_NAME_MAX),
		ar: trimmedOptionalText(MENU_IMPORT_NAME_MAX),
	})
	.strict()
	.transform(cleanLocalizedOutput)
	.refine((value) => Boolean(value.en || value.ar), {
		message: 'At least one localized name (en or ar) is required',
	})

export const localizedImportDescriptionSchema = z
	.object({
		en: trimmedOptionalText(MENU_IMPORT_DESCRIPTION_MAX),
		ar: trimmedOptionalText(MENU_IMPORT_DESCRIPTION_MAX),
	})
	.strict()
	.transform(cleanLocalizedOutput)

const finiteNonNegativePriceSchema = z
	.number()
	.finite()
	.min(0)
	.max(MENU_IMPORT_MAX_PRICE)

const currencyCodeSchema = z
	.string()
	.transform((value) => {
		const cleaned = value.trim().toUpperCase()
		return cleaned.length > 0 ? cleaned : null
	})
	.pipe(
		z
			.string()
			.regex(/^[A-Z]{3}$/)
			.nullable(),
	)
	.nullable()
	.optional()
	.transform((value) => value ?? null)

/**
 * Plain JSON-Schema-friendly schema passed to `@repo/ai` `generateObject`.
 * Intentionally omits `.transform()` / `.pipe()` so JSON schema generation
 * works across providers, while keeping `.strict()` and excluding safety fields
 * (`allergens`, `calories`, `calorieMin`, `calorieMax`, dietary flags).
 */
const modelLocalizedNameSchema = z
	.object({
		en: z.string().max(MENU_IMPORT_NAME_MAX).nullable().optional(),
		ar: z.string().max(MENU_IMPORT_NAME_MAX).nullable().optional(),
	})
	.strict()

const modelLocalizedDescriptionSchema = z
	.object({
		en: z.string().max(MENU_IMPORT_DESCRIPTION_MAX).nullable().optional(),
		ar: z.string().max(MENU_IMPORT_DESCRIPTION_MAX).nullable().optional(),
	})
	.strict()

export const menuImportModelSchema = z
	.object({
		detectedCurrency: z.string().max(8).nullable().optional(),
		detectedLocales: z
			.array(z.enum(['en', 'ar']))
			.max(2)
			.optional(),
		menus: z
			.array(
				z
					.object({
						name: modelLocalizedNameSchema,
						categories: z
							.array(
								z
									.object({
										name: modelLocalizedNameSchema,
										description: modelLocalizedDescriptionSchema
											.nullable()
											.optional(),
										items: z
											.array(
												z
													.object({
														name: modelLocalizedNameSchema,
														description: modelLocalizedDescriptionSchema
															.nullable()
															.optional(),
														price: finiteNonNegativePriceSchema,
														sizes: z
															.array(
																z
																	.object({
																		name: modelLocalizedNameSchema,
																		price: finiteNonNegativePriceSchema,
																	})
																	.strict(),
															)
															.max(MENU_IMPORT_MAX_SIZES)
															.optional(),
														modifierGroups: z
															.array(
																z
																	.object({
																		name: modelLocalizedNameSchema,
																		selectionType: z
																			.enum(['single', 'multiple'])
																			.optional(),
																		minSelections: z
																			.number()
																			.int()
																			.min(0)
																			.max(20)
																			.optional(),
																		maxSelections: z
																			.number()
																			.int()
																			.min(1)
																			.max(50)
																			.nullable()
																			.optional(),
																		options: z
																			.array(
																				z
																					.object({
																						name: modelLocalizedNameSchema,
																						price: finiteNonNegativePriceSchema,
																					})
																					.strict(),
																			)
																			.max(MENU_IMPORT_MAX_MODIFIER_OPTIONS),
																	})
																	.strict(),
															)
															.max(MENU_IMPORT_MAX_MODIFIER_GROUPS)
															.optional(),
														confidence: z
															.enum(MENU_IMPORT_CONFIDENCE_LEVELS)
															.optional(),
														lowConfidenceFields: z
															.array(z.enum(MENU_IMPORT_LOW_CONFIDENCE_FIELDS))
															.max(4)
															.optional(),
													})
													.strict(),
											)
											.max(MENU_IMPORT_MAX_ITEMS),
									})
									.strict(),
							)
							.max(MENU_IMPORT_MAX_CATEGORIES),
					})
					.strict(),
			)
			.max(MENU_IMPORT_MAX_MENUS),
	})
	.strict()

/**
 * Strict validation schema for model output before normalizing IDs and UI flags.
 * Trims strings, checks length caps, checks finite non-negative prices, and
 * rejects any extra keys (such as `allergens` or `calories`).
 */
export const menuImportValidatedModelSchema = z
	.object({
		detectedCurrency: currencyCodeSchema,
		detectedLocales: z
			.array(z.enum(['en', 'ar']))
			.max(2)
			.default(['en']),
		menus: z
			.array(
				z
					.object({
						name: localizedImportNameSchema,
						categories: z
							.array(
								z
									.object({
										name: localizedImportNameSchema,
										description: localizedImportDescriptionSchema
											.nullable()
											.optional()
											.transform((value): LocalizedImportText => value ?? {}),
										items: z
											.array(
												z
													.object({
														name: localizedImportNameSchema,
														description: localizedImportDescriptionSchema
															.nullable()
															.optional()
															.transform(
																(value): LocalizedImportText => value ?? {},
															),
														price: finiteNonNegativePriceSchema,
														sizes: z
															.array(
																z
																	.object({
																		name: localizedImportNameSchema,
																		price: finiteNonNegativePriceSchema,
																	})
																	.strict(),
															)
															.max(MENU_IMPORT_MAX_SIZES)
															.default([]),
														modifierGroups: z
															.array(
																z
																	.object({
																		name: localizedImportNameSchema,
																		selectionType: z
																			.enum(['single', 'multiple'])
																			.default('single'),
																		minSelections: z
																			.number()
																			.int()
																			.min(0)
																			.max(20)
																			.default(0),
																		maxSelections: z
																			.number()
																			.int()
																			.min(1)
																			.max(50)
																			.nullable()
																			.optional()
																			.transform((value) => value ?? null),
																		options: z
																			.array(
																				z
																					.object({
																						name: localizedImportNameSchema,
																						price: finiteNonNegativePriceSchema,
																					})
																					.strict(),
																			)
																			.max(MENU_IMPORT_MAX_MODIFIER_OPTIONS),
																	})
																	.strict(),
															)
															.max(MENU_IMPORT_MAX_MODIFIER_GROUPS)
															.default([]),
														confidence: z
															.enum(MENU_IMPORT_CONFIDENCE_LEVELS)
															.default('high'),
														lowConfidenceFields: z
															.array(z.enum(MENU_IMPORT_LOW_CONFIDENCE_FIELDS))
															.max(4)
															.default([]),
													})
													.strict(),
											)
											.max(MENU_IMPORT_MAX_ITEMS),
									})
									.strict(),
							)
							.max(MENU_IMPORT_MAX_CATEGORIES),
					})
					.strict(),
			)
			.max(MENU_IMPORT_MAX_MENUS),
	})
	.strict()

export const menuImportDraftOptionSchema = z
	.object({
		id: trimmedRequiredId,
		included: z.boolean().default(true),
		name: localizedImportNameSchema,
		price: finiteNonNegativePriceSchema,
	})
	.strict()

export const menuImportDraftModifierGroupSchema = z
	.object({
		id: trimmedRequiredId,
		included: z.boolean().default(true),
		name: localizedImportNameSchema,
		selectionType: z.enum(['single', 'multiple']).default('single'),
		minSelections: z.number().int().min(0).max(20).default(0),
		maxSelections: z
			.number()
			.int()
			.min(1)
			.max(50)
			.nullable()
			.optional()
			.transform((value) => value ?? null),
		options: z
			.array(menuImportDraftOptionSchema)
			.max(MENU_IMPORT_MAX_MODIFIER_OPTIONS),
	})
	.strict()

export const menuImportDraftSizeSchema = z
	.object({
		id: trimmedRequiredId,
		name: localizedImportNameSchema,
		price: finiteNonNegativePriceSchema,
	})
	.strict()

export const menuImportDraftItemSchema = z
	.object({
		id: trimmedRequiredId,
		included: z.boolean().default(true),
		name: localizedImportNameSchema,
		description: localizedImportDescriptionSchema
			.nullable()
			.optional()
			.transform((value): LocalizedImportText => value ?? {}),
		price: finiteNonNegativePriceSchema,
		sizes: z
			.array(menuImportDraftSizeSchema)
			.max(MENU_IMPORT_MAX_SIZES)
			.default([]),
		modifierGroups: z
			.array(menuImportDraftModifierGroupSchema)
			.max(MENU_IMPORT_MAX_MODIFIER_GROUPS)
			.default([]),
		confidence: z.enum(MENU_IMPORT_CONFIDENCE_LEVELS).default('high'),
		lowConfidenceFields: z
			.array(z.enum(MENU_IMPORT_LOW_CONFIDENCE_FIELDS))
			.max(4)
			.default([]),
		matchExistingItemId: trimmedRequiredId
			.nullable()
			.optional()
			.transform((value) => value ?? null),
	})
	.strict()

export const menuImportDraftCategorySchema = z
	.object({
		id: trimmedRequiredId,
		included: z.boolean().default(true),
		name: localizedImportNameSchema,
		description: localizedImportDescriptionSchema
			.nullable()
			.optional()
			.transform((value): LocalizedImportText => value ?? {}),
		items: z.array(menuImportDraftItemSchema).max(MENU_IMPORT_MAX_ITEMS),
	})
	.strict()

export const menuImportDraftMenuSchema = z
	.object({
		id: trimmedRequiredId,
		included: z.boolean().default(true),
		name: localizedImportNameSchema,
		categories: z
			.array(menuImportDraftCategorySchema)
			.max(MENU_IMPORT_MAX_CATEGORIES),
	})
	.strict()

export const menuImportImageSuggestionSchema = z
	.object({
		url: z
			.string()
			.trim()
			.url()
			.max(1000)
			.refine((value) => value.startsWith('https://'), {
				message: 'Image suggestion URLs must use HTTPS',
			}),
		alt: trimmedOptionalText(200).transform((value) => value ?? null),
	})
	.strict()

export const menuImportDraftSchema = z
	.object({
		version: z.literal(1),
		detectedCurrency: currencyCodeSchema,
		detectedLocales: z
			.array(z.enum(['en', 'ar']))
			.max(2)
			.default(['en']),
		menus: z.array(menuImportDraftMenuSchema).max(MENU_IMPORT_MAX_MENUS),
		imageSuggestions: z
			.array(menuImportImageSuggestionSchema)
			.max(MENU_IMPORT_MAX_IMAGE_SUGGESTIONS)
			.default([]),
	})
	.strict()

export type MenuImportDraft = z.infer<typeof menuImportDraftSchema>
export type MenuImportDraftMenu = z.infer<typeof menuImportDraftMenuSchema>
export type MenuImportDraftCategory = z.infer<
	typeof menuImportDraftCategorySchema
>
export type MenuImportDraftItem = z.infer<typeof menuImportDraftItemSchema>
export type MenuImportDraftSize = z.infer<typeof menuImportDraftSizeSchema>
export type MenuImportDraftModifierGroup = z.infer<
	typeof menuImportDraftModifierGroupSchema
>
export type MenuImportDraftOption = z.infer<typeof menuImportDraftOptionSchema>
export type MenuImportImageSuggestion = z.infer<
	typeof menuImportImageSuggestionSchema
>

export function normalizeModelOutputToDraft(
	rawOutput: unknown,
	imageSuggestions: MenuImportImageSuggestion[] = [],
): { ok: true; draft: MenuImportDraft } | { ok: false; issues: z.ZodIssue[] } {
	const parsed = menuImportValidatedModelSchema.safeParse(rawOutput)
	if (!parsed.success) {
		return { ok: false, issues: parsed.error.issues }
	}
	const draft: MenuImportDraft = {
		version: 1,
		detectedCurrency: parsed.data.detectedCurrency,
		detectedLocales:
			parsed.data.detectedLocales.length > 0
				? Array.from(new Set(parsed.data.detectedLocales))
				: ['en'],
		menus: parsed.data.menus.map((menu) => ({
			id: createId(),
			included: true,
			name: menu.name,
			categories: menu.categories.map((category) => ({
				id: createId(),
				included: true,
				name: category.name,
				description: category.description,
				items: category.items.map((item) => ({
					id: createId(),
					included: true,
					name: item.name,
					description: item.description,
					price: item.price,
					sizes: item.sizes.map((size) => ({
						id: createId(),
						name: size.name,
						price: size.price,
					})),
					modifierGroups: item.modifierGroups.map((group) => ({
						id: createId(),
						included: true,
						name: group.name,
						selectionType: group.selectionType,
						minSelections: group.minSelections,
						maxSelections: group.maxSelections,
						options: group.options.map((option) => ({
							id: createId(),
							included: true,
							name: option.name,
							price: option.price,
						})),
					})),
					confidence: item.confidence,
					lowConfidenceFields: Array.from(new Set(item.lowConfidenceFields)),
					matchExistingItemId: null,
				})),
			})),
		})),
		imageSuggestions: imageSuggestions.slice(
			0,
			MENU_IMPORT_MAX_IMAGE_SUGGESTIONS,
		),
	}

	const finalCheck = menuImportDraftSchema.safeParse(draft)
	if (!finalCheck.success) {
		return { ok: false, issues: finalCheck.error.issues }
	}
	return { ok: true, draft: finalCheck.data }
}

export function countDraftItems(draft: MenuImportDraft): number {
	let total = 0
	for (const menu of draft.menus) {
		for (const category of menu.categories) {
			total += category.items.length
		}
	}
	return total
}

export function pickDraftText(
	text: LocalizedImportText | null | undefined,
	preferredLocale: string = 'en',
): string {
	if (!text) return ''
	if (preferredLocale === 'ar') {
		return text.ar?.trim() || text.en?.trim() || ''
	}
	return text.en?.trim() || text.ar?.trim() || ''
}

/**
 * Serializes localized EN/AR draft text into Menuza's JSON localized string
 * format, writing ONLY locales configured on the organization (`orgLocales`).
 * If none of the org's locales exist on the draft text, falls back to writing
 * the available text under `defaultLocale` when `required` is true.
 */
export function serializeLocalizedTextForOrg(
	text: LocalizedImportText | null | undefined,
	orgLocales: readonly string[],
	defaultLocale: string,
	required: boolean,
): string | null {
	if (!text) return null
	const allowedLocales = new Set(orgLocales)
	const map: Record<string, string> = {}

	if (allowedLocales.has('en') && text.en?.trim()) {
		map.en = text.en.trim()
	}
	if (allowedLocales.has('ar') && text.ar?.trim()) {
		map.ar = text.ar.trim()
	}

	if (Object.keys(map).length === 0) {
		if (!required) return null
		const fallback =
			text[defaultLocale === 'ar' ? 'ar' : 'en']?.trim() ||
			text.en?.trim() ||
			text.ar?.trim() ||
			''
		if (!fallback) return null
		map[defaultLocale] = fallback
	}

	const serialized = serializeLocalizedString(map)
	return serialized || null
}

export function normalizeMatchName(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function hasCurrencyMismatch(
	detectedCurrency: string | null | undefined,
	orgCurrency: string | null | undefined,
): boolean {
	if (!detectedCurrency) return false
	const detected = detectedCurrency.trim().toUpperCase()
	const org = (orgCurrency || 'USD').trim().toUpperCase()
	if (!detected || !org) return false
	return detected !== org
}
