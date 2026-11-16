import { describe, expect, it } from 'vitest'
import {
	AI_DRAFT_OPERATOR_RATE_LIMIT,
	AI_DRAFT_ORGANIZATION_RATE_LIMIT,
	checkRateLimit,
} from '#app/utils/rate-limit.server.ts'

describe('AI draft rate limits (#155), on the real DB-backed limiter', () => {
	it('allows 20 per operator per hour, then refuses the 21st', async () => {
		const key = { type: 'user' as const, value: `ai-op-${Date.now()}` }
		for (let i = 0; i < 20; i += 1) {
			expect((await checkRateLimit(key, AI_DRAFT_OPERATOR_RATE_LIMIT)).allowed).toBe(true)
		}
		expect((await checkRateLimit(key, AI_DRAFT_OPERATOR_RATE_LIMIT)).allowed).toBe(false)
		// Another operator has their own budget.
		expect(
			(await checkRateLimit({ type: 'user', value: `${key.value}-2` }, AI_DRAFT_OPERATOR_RATE_LIMIT)).allowed,
		).toBe(true)
	})

	it('allows 200 per organization per day, then refuses the 201st', async () => {
		const key = { type: 'org' as const, value: `ai-org-${Date.now()}` }
		for (let i = 0; i < 200; i += 1) {
			expect((await checkRateLimit(key, AI_DRAFT_ORGANIZATION_RATE_LIMIT)).allowed).toBe(true)
		}
		expect((await checkRateLimit(key, AI_DRAFT_ORGANIZATION_RATE_LIMIT)).allowed).toBe(false)
	})
})
