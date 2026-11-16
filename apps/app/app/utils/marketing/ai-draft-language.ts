/** The language an AI draft starts in: the organization's default site language, English or Arabic. */
export function programLanguageOf(
	locale: string | null | undefined,
): 'en' | 'ar' {
	return (locale ?? 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en'
}
