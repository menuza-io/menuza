import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	customers,
	getTenantDb,
	marketingMessages,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import {
	resetEmailEngagementSyncThrottle,
	syncEmailEngagementForAllOrgs,
	syncEmailEngagementForOrg,
} from './email-engagement-sync.ts'

vi.mock('@repo/email', () => ({
	fetchOciEngagementEvents: vi.fn(),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(true),
}))

import {
	fetchOciEngagementEvents,
	isOciEngagementLoggingConfigured,
} from '@repo/email'

describe('email-engagement-sync', () => {
	let tempDir: string
	const orgId = `org_eng_${Date.now()}`

	beforeEach(async () => {
		resetEmailEngagementSyncThrottle()
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagement-sync-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		vi.mocked(isOciEngagementLoggingConfigured).mockReturnValue(true)
		vi.mocked(fetchOciEngagementEvents).mockReset()
	})

	afterEach(() => {
		delete process.env.TENANT_DB_DIR
	})

	it('updates marketing message status from OCI open/click events', async () => {
		const db = await getTenantDb(orgId)
		const customerId = randomUUID()
		const messageId = randomUUID()

		await db.insert(customers).values({
			id: customerId,
			name: 'Taylor',
			email: 'taylor@example.com',
			phone: '+15555550100',
		})

		await db.insert(marketingMessages).values({
			id: messageId,
			customerId,
			channel: 'email',
			status: 'Sent',
			sentAt: new Date('2026-01-01T12:00:00.000Z'),
		})

		vi.mocked(fetchOciEngagementEvents).mockResolvedValue([
			{
				action: 'open',
				messageId,
				orgId,
				occurredAt: new Date('2026-01-01T12:30:00.000Z'),
			},
			{
				action: 'click',
				messageId,
				orgId,
				occurredAt: new Date('2026-01-01T12:45:00.000Z'),
			},
		])

		const result = await syncEmailEngagementForOrg(orgId, { force: true })
		expect(result.synced).toBe(true)
		expect(result.eventsApplied).toBe(2)

		const [updated] = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.id, messageId))

		expect(updated?.status).toBe('Clicked')
		expect(updated?.openedAt?.toISOString()).toBe('2026-01-01T12:30:00.000Z')
		expect(updated?.clickedAt?.toISOString()).toBe('2026-01-01T12:45:00.000Z')
	})

	it('keeps syncing other orgs when one org has no database on this node', async () => {
		const db = await getTenantDb(orgId)
		const customerId = randomUUID()
		const messageId = randomUUID()
		await db.insert(customers).values({
			id: customerId,
			name: 'Jordan',
			email: 'jordan@example.com',
			phone: '+15555550101',
		})
		await db.insert(marketingMessages).values({
			id: messageId,
			customerId,
			channel: 'email',
			status: 'Sent',
			sentAt: new Date('2026-01-01T12:00:00.000Z'),
		})
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.mocked(fetchOciEngagementEvents).mockResolvedValue([
			{
				action: 'open',
				messageId: randomUUID(),
				orgId: 'org_not_on_this_node',
				occurredAt: new Date('2026-01-01T12:10:00.000Z'),
			},
			{
				action: 'click',
				messageId,
				orgId,
				occurredAt: new Date('2026-01-01T12:45:00.000Z'),
			},
		])

		const result = await syncEmailEngagementForAllOrgs()
		expect(result.synced).toBe(true)
		expect(result.eventsApplied).toBe(1)
		expect(errorSpy).toHaveBeenCalledWith(
			'Email engagement sync failed for organization',
			expect.objectContaining({ orgId: 'org_not_on_this_node' }),
		)

		const [updated] = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.id, messageId))
		expect(updated?.clickedAt?.toISOString()).toBe('2026-01-01T12:45:00.000Z')
	})
})
