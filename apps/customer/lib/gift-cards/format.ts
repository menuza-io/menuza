import { latinDigits } from '../loyalty/format'

/** A date as the language writes it (Western digits), or '' when it cannot be formatted. */
export function formatGiftCardDate(ms: number, locale: string): string {
	try {
		return new Intl.DateTimeFormat(latinDigits(locale), {
			dateStyle: 'medium',
		}).format(new Date(ms))
	} catch {
		return ''
	}
}
