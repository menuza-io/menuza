import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0065 (#139) gives every already connected domain a primary
 * SiteDomain row and leaves Organization.customDomain as it was, so existing
 * domains keep working through the upgrade.
 */

const drizzleDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle',
)

type Journal = { entries: Array<{ idx: number; tag: string }> }

function migrationsUpTo(tempDir: string, lastTag: string) {
	const folder = path.join(tempDir, 'drizzle-partial')
	fs.cpSync(drizzleDir, folder, { recursive: true })
	const journalPath = path.join(folder, 'meta/_journal.json')
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
	const last = journal.entries.findIndex((entry) => entry.tag === lastTag)
	expect(last).toBeGreaterThan(-1)
	journal.entries = journal.entries.slice(0, last + 1)
	fs.writeFileSync(journalPath, JSON.stringify(journal))
	return folder
}

describe('migration 0065 (custom domains)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-0065-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, '0064_website_publishing'),
		})
		await client.executeMultiple(`
			INSERT INTO Organization (id, name, slug, createdAt, updatedAt, customDomain, customDomainStatus, cloudflareHostnameId) VALUES
				('live', 'Live', 'live', 1, 1, 'WWW.Live.example.com', 'active', 'cf-live'),
				('waiting', 'Waiting', 'waiting', 1, 1, 'waiting.example.com', 'pending', 'cf-waiting'),
				('nostatus', 'No status', 'nostatus', 1, 1, 'nostatus.example.com', NULL, NULL),
				('odd', 'Odd', 'odd', 1, 1, 'odd.example.com', 'deleted', 'cf-odd'),
				('none', 'None', 'none', 1, 1, NULL, NULL, NULL),
				('blank', 'Blank', 'blank', 1, 1, '', NULL, NULL);
		`)
		await migrate(drizzle(client), { migrationsFolder: drizzleDir })
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('makes each connected domain the primary host of its organization', async () => {
		const rows = (
			await client.execute(
				'SELECT organizationId, hostname, isPrimary, method, cloudflareHostnameId, status FROM SiteDomain ORDER BY organizationId',
			)
		).rows.map((row) => ({ ...row }))
		expect(rows).toEqual([
			{
				organizationId: 'live',
				hostname: 'www.live.example.com',
				isPrimary: 1,
				method: 'cname',
				cloudflareHostnameId: 'cf-live',
				status: 'active',
			},
			{
				organizationId: 'nostatus',
				hostname: 'nostatus.example.com',
				isPrimary: 1,
				method: 'cname',
				cloudflareHostnameId: null,
				status: 'pending',
			},
			{
				organizationId: 'odd',
				hostname: 'odd.example.com',
				isPrimary: 1,
				method: 'cname',
				cloudflareHostnameId: 'cf-odd',
				status: 'error',
			},
			{
				organizationId: 'waiting',
				hostname: 'waiting.example.com',
				isPrimary: 1,
				method: 'cname',
				cloudflareHostnameId: 'cf-waiting',
				status: 'pending',
			},
		])
	})

	it('starts the pending clock for waiting domains and leaves live ones without one', async () => {
		const rows = (
			await client.execute(
				'SELECT organizationId, pendingSince FROM SiteDomain ORDER BY organizationId',
			)
		).rows
		const byOrg = Object.fromEntries(
			rows.map((row) => [row.organizationId as string, row.pendingSince]),
		)
		expect(byOrg.live).toBeNull()
		expect(Number(byOrg.waiting)).toBeGreaterThan(1_700_000_000_000)
	})

	it('leaves Organization.customDomain untouched', async () => {
		const row = (
			await client.execute(
				"SELECT customDomain, customDomainStatus FROM Organization WHERE id = 'live'",
			)
		).rows[0]
		expect(row).toMatchObject({
			customDomain: 'WWW.Live.example.com',
			customDomainStatus: 'active',
		})
	})
})
