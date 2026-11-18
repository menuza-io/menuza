import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0059 (#335) adds the dietary tag list and fills it from the old
 * vegetarian and gluten-free flags, leaving the flags exactly as they were.
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

describe('migration 0059 (dietary tags)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-0059-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, '0058_sales_goals'),
		})
		await client.executeMultiple(`
			INSERT INTO Organization (id, name, slug, createdAt, updatedAt) VALUES ('o1', 'Org', 'org', 1, 1);
			INSERT INTO OrganizationMenuItem (id, organizationId, displayName, isVegetarian, isGlutenFree, isAlcohol, createdAt, updatedAt) VALUES
				('both', 'o1', 'Salad', 1, 1, 0, 1, 1),
				('veg', 'o1', 'Pasta', 1, 0, 0, 1, 1),
				('gf', 'o1', 'Steak', 0, 1, 0, 1, 1),
				('none', 'o1', 'Beer', 0, 0, 1, 1, 1);
			INSERT INTO OrganizationMenuOption (id, organizationId, displayName, isVegetarian, isGlutenFree, createdAt, updatedAt) VALUES
				('opt-veg', 'o1', 'Tofu', 1, 0, 1, 1),
				('opt-none', 'o1', 'Bacon', 0, 0, 1, 1);
		`)
		await migrate(drizzle(client), { migrationsFolder: drizzleDir })
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('copies the old flags into tags and keeps the flags', async () => {
		const items = (
			await client.execute(
				'SELECT id, dietaryTags, isVegetarian, isGlutenFree, isAlcohol, orderTypePrices FROM OrganizationMenuItem ORDER BY id',
			)
		).rows.map((row) => ({ ...row }))
		expect(items).toEqual([
			{
				id: 'both',
				dietaryTags: '["vegetarian","gluten_free"]',
				isVegetarian: 1,
				isGlutenFree: 1,
				isAlcohol: 0,
				orderTypePrices: null,
			},
			{
				id: 'gf',
				dietaryTags: '["gluten_free"]',
				isVegetarian: 0,
				isGlutenFree: 1,
				isAlcohol: 0,
				orderTypePrices: null,
			},
			{
				id: 'none',
				dietaryTags: '[]',
				isVegetarian: 0,
				isGlutenFree: 0,
				isAlcohol: 1,
				orderTypePrices: null,
			},
			{
				id: 'veg',
				dietaryTags: '["vegetarian"]',
				isVegetarian: 1,
				isGlutenFree: 0,
				isAlcohol: 0,
				orderTypePrices: null,
			},
		])
		const options = (
			await client.execute(
				'SELECT id, dietaryTags, isVegetarian FROM OrganizationMenuOption ORDER BY id',
			)
		).rows.map((row) => ({ ...row }))
		expect(options).toEqual([
			{ id: 'opt-none', dietaryTags: '[]', isVegetarian: 0 },
			{ id: 'opt-veg', dietaryTags: '["vegetarian"]', isVegetarian: 1 },
		])
	})

	it('creates the pricing rule table', async () => {
		await client.execute(
			"INSERT INTO OrganizationMenuPricingRule (id, organizationId, name, percentBp, createdAt, updatedAt) VALUES ('r1', 'o1', 'Plus ten', 1000, 1, 1)",
		)
		const rule = (
			await client.execute('SELECT * FROM OrganizationMenuPricingRule')
		).rows[0]
		expect(rule).toMatchObject({
			roundingMode: 'none',
			menuIds: '[]',
			locationIds: '[]',
			endedAt: null,
		})
	})
})
