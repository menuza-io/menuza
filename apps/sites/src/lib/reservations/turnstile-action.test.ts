import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESERVATIONS_TURNSTILE_ACTION as SHARED } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import { RESERVATIONS_TURNSTILE_ACTION } from './ui.ts'

const dir = __dirname
const sources = readdirSync(dir).filter(
	(f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
)

describe('Turnstile action contract', () => {
	it('Sites uses the same action the tenant-api verifies', () => {
		expect(RESERVATIONS_TURNSTILE_ACTION).toBe(SHARED)
		const server = readFileSync(
			join(dir, '../../../../tenant-api/src/lib/reservations-public-auth.ts'),
			'utf8',
		)
		expect(server).toContain('expectedAction: RESERVATIONS_TURNSTILE_ACTION')
	})

	it('every widget uses the default action (no per-widget override)', () => {
		for (const file of sources) {
			const text = readFileSync(join(dir, file), 'utf8')
			for (const m of text.matchAll(/createChallenge\(([\s\S]*?)\)/g)) {
				const args = m[1]!.split(',').filter((a) => a.trim())
				if (file === 'ui.ts' && m[1]!.includes('container')) continue
				expect(args.length, `${file}: ${m[0]}`).toBeLessThanOrEqual(2)
			}
			expect(text).not.toMatch(/waitlist-join'|reservation-notify'/)
		}
	})
})
