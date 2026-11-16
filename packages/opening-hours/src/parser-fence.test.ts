import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
)

describe('hours parser fence', () => {
	it('allows only @repo/opening-hours to own parseWeeklyHours', () => {
		const pattern = String.raw`function parseWeeklyHours|export function parseWeeklyHours`
		let out = ''
		try {
			out = execSync(
				`rg -l "${pattern}" packages apps --glob '!**/opening-hours/**' --glob '!**/node_modules/**'`,
				{ cwd: root, encoding: 'utf8' },
			)
		} catch {
			out = ''
		}
		const offenders = out
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
		expect(offenders).toEqual([])
	})
})
