import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { careersApplySchema, HIRING_LIMITS } from '@repo/staffing'
import { hiringApplications } from '@repo/tenant-db'
import {
	createHiringHarness,
	LOC_1,
	ORG_A,
	type HiringHarness,
} from '../../tests/hiring-harness.ts'
import { type LivePosting } from '../lib/job-posting-context.ts'
import { submitApplication } from './careers-apply-service.ts'

const POSTING: LivePosting = {
	id: 'post-1',
	slug: 'post-1',
	title: 'Crew',
	positionName: 'Crew',
	scopeIds: [LOC_1],
	questions: [],
}

describe('submitApplication limits', () => {
	let h: HiringHarness
	beforeEach(async () => {
		h = await createHiringHarness()
	})
	afterEach(async () => {
		await h.cleanup()
	})

	it('holds the per-address ceiling under concurrent submissions', async () => {
		const db = await h.db(ORG_A)
		const now = Date.now()
		const submissions = Array.from({ length: 12 }, (_, i) =>
			submitApplication(db, {
				orgId: ORG_A,
				posting: POSTING,
				body: careersApplySchema.parse({
					postingSlug: 'post-1',
					firstName: 'Sam',
					lastName: `Person${i}`,
					email: `person${i}@example.com`,
					locale: 'en',
					answers: {},
					consent: true,
					consentVersion: '2026-10',
				}),
				ipHash: 'ip-hash-1',
				now,
			}),
		)
		const outcomes = await Promise.all(submissions)
		const stored = await db.select().from(hiringApplications)
		expect(stored).toHaveLength(HIRING_LIMITS.perIpPerHour)
		expect(outcomes.filter((o) => o.status === 'rate_limited').length).toBe(
			12 - HIRING_LIMITS.perIpPerHour,
		)
	})
})
