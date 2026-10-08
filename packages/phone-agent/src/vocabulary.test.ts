import { describe, expect, it } from 'vitest'

const FORBIDDEN = [
	/restaurant/i,
	/\border(?:s|ed|ing)?\b/i,
	/\bcarts?\b/i,
	/pick-?up/i,
	/deliver/i,
	/reserv/i,
	/catering/i,
	/\blocations?\b/i,
	/\bstores?\b/i,
	/\bdish(?:es)?\b/i,
	/\bfood\b/i,
	/\bmenus?\b/i,
]

// The core keeps "menu" only for the phone keypad menu (IVR), so those
// spellings and identifiers built on them are removed before checking.
const KEYPAD_MENU = [
	/\b(?:keypad|phone)[ _-]menus?\b/gi,
	/\b(?:main|closed)[ _]menu\b/gi,
	/\b\w+menu\w*\b|\bmenu\w+\b/gi,
]

function coreSources() {
	const files = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], {
		query: '?raw',
		import: 'default',
		eager: true,
	})
	return Object.entries(files).map(([name, text]) => ({ name, text }))
}

describe('core vocabulary', () => {
	it('has no business-type words outside the vertical plug-ins', () => {
		const hits: string[] = []
		for (const { name, text } of coreSources()) {
			text.split('\n').forEach((line, index) => {
				const checked = KEYPAD_MENU.reduce(
					(current, pattern) => current.replace(pattern, ''),
					line,
				)
				for (const pattern of FORBIDDEN) {
					const match = pattern.exec(checked)
					if (match) hits.push(`${name}:${index + 1}: "${match[0]}"`)
				}
			})
		}
		expect(hits).toEqual([])
	})
})
