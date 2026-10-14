import { db, eq, JobPosting } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action } from './jobs.job-postings-expiry.ts'

function call(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL(
		'http://localhost:3001/resources/jobs/job-postings-expiry',
	)
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/job-postings-expiry',
	}) as Promise<Response>
}

async function posting(
	organizationId: string,
	slug: string,
	overrides: Partial<typeof JobPosting.$inferInsert>,
) {
	const [row] = await db
		.insert(JobPosting)
		.values({
			organizationId,
			slug,
			title: 'Cook',
			positionName: 'Cook',
			...overrides,
		})
		.returning()
	return row!
}

describe('jobs.job-postings-expiry', () => {
	it('is POST only and needs the internal command token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id)
		const ended = await posting(organization.id, 'ended', {
			status: 'published',
			expiresAt: new Date(Date.now() - 60_000),
		})
		let status = 0
		try {
			status = (await call({ authorized: false })).status
		} catch (error) {
			status = error instanceof Response ? error.status : 302
		}
		expect([301, 302, 303, 401, 403]).toContain(status)
		const [untouched] = await db
			.select()
			.from(JobPosting)
			.where(eq(JobPosting.id, ended.id))
		expect(untouched?.status).toBe('published')
	})

	it('expires only live postings that have ended and answers with a count', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id)
		const past = new Date(Date.now() - 60_000)
		const future = new Date(Date.now() + 86_400_000)
		const ended = await posting(organization.id, 'ended', {
			status: 'published',
			expiresAt: past,
		})
		const open = await posting(organization.id, 'open', {
			status: 'published',
			expiresAt: future,
		})
		const forever = await posting(organization.id, 'forever', {
			status: 'published',
		})
		const draft = await posting(organization.id, 'draft', {
			status: 'draft',
			expiresAt: past,
		})
		const closed = await posting(organization.id, 'closed', {
			status: 'closed',
			expiresAt: past,
		})

		const response = await call()
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toMatchObject({ success: true })
		expect(body.expired).toBeGreaterThanOrEqual(1)
		// Counts only: nothing about the postings leaks into the response.
		expect(JSON.stringify(body)).not.toMatch(/Cook|ended|organization/)

		const statuses = Object.fromEntries(
			(
				await db
					.select({ id: JobPosting.id, status: JobPosting.status })
					.from(JobPosting)
					.where(eq(JobPosting.organizationId, organization.id))
			).map((row) => [row.id, row.status]),
		)
		expect(statuses).toEqual({
			[ended.id]: 'expired',
			[open.id]: 'published',
			[forever.id]: 'published',
			[draft.id]: 'draft',
			[closed.id]: 'closed',
		})

		// Running it again changes nothing.
		const again = (await (await call()).json()) as { expired: number }
		expect(again.expired).toBe(0)
	})
})
