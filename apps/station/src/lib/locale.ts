/**
 * The till's languages, without the catalogs (so code that only needs to know
 * which language applies, such as the store, does not load them).
 */
export const POS_LOCALES = ['en', 'ar'] as const
export type PosLocale = (typeof POS_LOCALES)[number]

/** The language a till uses: its own choice, else the restaurant's default when that is Arabic. */
export const effectiveLocale = (
	chosen: PosLocale | null,
	restaurantDefault: string | undefined,
): PosLocale =>
	chosen ?? (restaurantDefault?.toLowerCase().startsWith('ar') ? 'ar' : 'en')
