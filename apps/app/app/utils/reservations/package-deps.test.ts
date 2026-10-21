import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../../../..')
const read = (file: string) =>
	JSON.parse(readFileSync(path.join(root, file), 'utf8')) as {
		dependencies?: Record<string, string>
		packages?: Record<string, { dependencies?: Record<string, string> }>
	}

describe('@repo/reservations dependency', () => {
	it('is declared by the App package', () => {
		expect(
			read('apps/app/package.json').dependencies?.['@repo/reservations'],
		).toBe('*')
	})

	it('is recorded in the lockfile entry for apps/app', () => {
		const lock = read('package-lock.json')
		expect(
			lock.packages?.['apps/app']?.dependencies?.['@repo/reservations'],
		).toBe('*')
	})
})
