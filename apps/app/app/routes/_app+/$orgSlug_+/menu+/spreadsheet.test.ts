import { auditService } from '@repo/audit'
import { ConfigFlag, db, eq, OrganizationMenuItem } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

import { action, loader } from './spreadsheet.tsx'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function setup(role: 'admin' | 'viewer' = 'admin', flag = true) {
	const s = await setupTestOrgWithUser(role)
	if (flag) {
		await db.insert(ConfigFlag).values({
			key: 'menu.bulk_edit',
			value: true,
			level: 'organization',
			organizationId: s.organization.id,
		})
	}
	const insert = async (name: string, price: number, extra: object = {}) => {
		const [row] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: s.organization.id,
				displayName: JSON.stringify({ en: name }),
				price,
				...extra,
			})
			.returning()
		return row!
	}
	const soup = await insert('Soup', 10, { orderTypePrices: '{"delivery":12}' })
	const tea = await insert('Tea', 3)
	return { ...s, soup, tea }
}

function call(
	s: Setup,
	init: { method?: string; body?: unknown; query?: string } = {},
) {
	const request = new Request(
		`https://app.example/${s.organization.slug}/menu/spreadsheet${init.query ?? ''}`,
		{
			method: init.method ?? 'GET',
			headers: { cookie: s.cookie, 'content-type': 'application/json' },
			...(init.body ? { body: JSON.stringify(init.body) } : {}),
		},
	)
	const args = {
		request,
		params: { orgSlug: s.organization.slug },
		context: new RouterContextProvider(),
	} as never
	return (init.method === 'POST' ? action(args) : loader(args)).catch(
		(thrown: unknown) => {
			if (thrown instanceof Response) return thrown
			throw thrown
		},
	) as Promise<Response>
}

async function download(s: Setup) {
	const response = await call(s, { query: '?download=1' })
	expect(response.headers.get('content-type')).toContain('text/csv')
	return response.text()
}

const post = (s: Setup, body: unknown) => call(s, { method: 'POST', body })

describe('menu spreadsheet update (#411)', () => {
	it('previews one change for one changed price, applies it, and logs it', async () => {
		const s = await setup()
		const csv = (await download(s)).replace(
			`${s.soup.id},Soup,,10.00`,
			`${s.soup.id},Soup,,11.00`,
		)
		const previewed = (await (
			await post(s, { intent: 'preview', csv })
		).json()) as {
			preview: {
				changes: Array<{ itemId: string; fields: string[] }>
				problems: unknown[]
				stamps: Record<string, string>
			}
		}
		expect(previewed.preview.problems).toEqual([])
		expect(previewed.preview.changes).toEqual([
			expect.objectContaining({ itemId: s.soup.id, fields: ['price'] }),
		])
		// Preview writes nothing.
		const [before] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, s.soup.id))
		expect(before!.price).toBe(10)

		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const applied = await post(s, {
			intent: 'apply',
			csv,
			stamps: previewed.preview.stamps,
		})
		expect(await applied.json()).toMatchObject({ ok: true, applied: 1 })
		const [after] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, s.soup.id))
		// The base price changed; the delivery price, untouched in the file, stays.
		expect(after!.price).toBe(11)
		expect(after!.orderTypePrices).toBe('{"delivery":12}')
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({ resourceType: 'menu_spreadsheet' }),
		)
	})

	it('lists a bad row and applies nothing', async () => {
		const s = await setup()
		const csv = `id,price,availability\n${s.soup.id},12,\n${s.tea.id},abc,`
		const previewed = (await (
			await post(s, { intent: 'preview', csv })
		).json()) as {
			preview: {
				changes: unknown[]
				problems: Array<{ row: number; problem: string }>
				stamps: Record<string, string>
			}
		}
		expect(previewed.preview.problems).toEqual([
			expect.objectContaining({ row: 3, problem: 'bad_price' }),
		])
		const refused = await post(s, {
			intent: 'apply',
			csv,
			stamps: previewed.preview.stamps,
		})
		expect(refused.status).toBe(422)
		expect(await refused.json()).toMatchObject({
			ok: false,
			error: 'has_problems',
		})
		const rows = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, s.organization.id))
		expect(rows.map((row) => row.price).sort()).toEqual([10, 3].sort())
	})

	it('leaves blank cells untouched', async () => {
		const s = await setup()
		const csv = `id,price,delivery_price,availability\n${s.soup.id},,,sold out\n${s.tea.id},,,`
		const previewed = (await (
			await post(s, { intent: 'preview', csv })
		).json()) as {
			preview: {
				changes: Array<{ itemId: string; fields: string[] }>
				stamps: Record<string, string>
			}
		}
		expect(previewed.preview.changes).toEqual([
			expect.objectContaining({ itemId: s.soup.id, fields: ['availability'] }),
		])
		await post(s, { intent: 'apply', csv, stamps: previewed.preview.stamps })
		const [soup] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, s.soup.id))
		expect(soup).toMatchObject({
			price: 10,
			orderTypePrices: '{"delivery":12}',
			availabilityStatus: 'unavailable',
		})
	})

	it('refuses a file that is not the template, and a dish changed since the preview', async () => {
		const s = await setup()
		const wrong = await post(s, {
			intent: 'preview',
			csv: 'name,cost\nSoup,10',
		})
		expect(wrong.status).toBe(422)
		expect(await wrong.json()).toEqual({ error: 'not_template' })
		const csv = `id,price\n${s.soup.id},13`
		const previewed = (await (
			await post(s, { intent: 'preview', csv })
		).json()) as {
			preview: { stamps: Record<string, string> }
		}
		await db
			.update(OrganizationMenuItem)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(eq(OrganizationMenuItem.id, s.soup.id))
		const stale = await post(s, {
			intent: 'apply',
			csv,
			stamps: previewed.preview.stamps,
		})
		expect(stale.status).toBe(409)
	})

	it('is part of bulk edit: hidden without the flag, and needs menu write access', async () => {
		const off = await setup('admin', false)
		expect((await call(off)).status).toBe(404)
		const viewer = await setup('viewer')
		expect(
			(await post(viewer, { intent: 'preview', csv: 'id\n' })).status,
		).toBe(403)
	})
})
