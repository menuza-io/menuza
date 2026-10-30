import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setupI18n, type I18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'

export const CONTENT_LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const

/** English messages straight from the source text (an empty catalog falls back to it). */
export function testI18n(locale = 'en'): I18n {
	return setupI18n({ locale, messages: { [locale]: {} } })
}

/** `msgid` to `msgstr` in the app's own catalog (`locales/<locale>.po`); obsolete `#~` entries are skipped. */
export function readCatalog(locale: string): Map<string, string> {
	const file = path.resolve(__dirname, `../../locales/${locale}.po`)
	const entries = new Map<string, string>()
	let current: 'id' | 'str' | null = null
	let id = ''
	let str = ''
	const flush = () => {
		if (id) entries.set(id, str)
		id = ''
		str = ''
	}
	const unquote = (line: string) =>
		JSON.parse(line.slice(line.indexOf('"'))) as string
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.startsWith('msgid ')) {
			flush()
			current = 'id'
			id = unquote(line)
		} else if (line.startsWith('msgstr ')) {
			current = 'str'
			str = unquote(line)
		} else if (line.startsWith('"') && current) {
			if (current === 'id') id += unquote(line)
			else str += unquote(line)
		} else if (!line.trim()) {
			flush()
			current = null
		}
	}
	flush()
	return entries
}

/** An i18n whose messages are the app's catalog of that locale, keyed by message id. */
export function catalogI18n(locale: string): I18n {
	const messages = Object.fromEntries(
		[...readCatalog(locale)].map(([source, translation]) => [
			generateMessageId(source),
			translation,
		]),
	)
	return setupI18n({ locale, messages: { [locale]: messages } })
}
