import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	formExportAudit,
	getTenantDb,
	provisionTenantDb,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mailboxRoutes } from './mailbox.ts'

const orgId = 'clw9x0a12000008l00test79'
const otherOrgId = 'clw9x0a12000008l00test80'
const secret = 'test-operator-secret-123456789'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/origin.ts')>()
	return {
		...actual,
		findActiveOrganizationById: async (id: string) =>
			id.startsWith('clw9x0a12000008l00test')
				? { id, slug: 'acme', dataRegion: 'us' }
				: null,
	}
})

vi.mock('../lib/mailbox-ai.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/mailbox-ai.ts')>()
	return { ...actual, isMailboxAIConfigured: () => true }
})

function mint(
	claims: { restrictedForms?: boolean; org?: string; scope?: string } = {},
) {
	return new SignJWT({
		orgId: claims.org ?? orgId,
		role: 'operator',
		scope: claims.scope ?? 'mailbox',
		...(claims.restrictedForms ? { restrictedForms: true } : {}),
	})
		.setSubject('user-1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(secret))
}

describe('mailbox: restricted forms and CSV export', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tenant-api-mailbox-forms-'),
		)
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = secret
		process.env.TENANT_OPERATOR_TOKEN = secret
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		const db = await getTenantDb(orgId)
		await db.insert(websiteForms).values([
			{
				id: 'open',
				name: 'Contact',
				fields: [
					{ id: 'name', type: 'name', label: 'Name', required: true },
					{ id: 'note', type: 'textarea', label: 'Note', required: false },
				],
				successMessage: 'ok',
			},
			{
				id: 'secret',
				name: 'Allergies',
				restricted: true,
				fields: [{ id: 'name', type: 'name', label: 'Name', required: true }],
				successMessage: 'ok',
			},
		])
		await db.insert(websiteFormSubmissions).values([
			{
				id: 'sub-open-1',
				formId: 'open',
				values: { name: 'Sam', note: '=HYPERLINK("http://evil","x")' },
				createdAt: new Date('2026-03-02T10:00:00Z'),
			},
			{
				id: 'sub-open-2',
				formId: 'open',
				values: { name: '+cmd|calc', note: 'later' },
				createdAt: new Date('2026-03-10T10:00:00Z'),
			},
			{
				id: 'sub-secret-1',
				formId: 'secret',
				values: { name: 'Peanut allergy Pat' },
				createdAt: new Date('2026-03-03T10:00:00Z'),
			},
		])
		app = new Hono()
		app.route('/operator/mailbox', mailboxRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		await destroyTenantDb(otherOrgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function call(
		method: string,
		route: string,
		token: string,
		body?: unknown,
	) {
		return app.request(`/operator/mailbox${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	it('a token without the claim sees no restricted response, only that the form exists', async () => {
		const res = await call('GET', '/forms', await mint())
		const body = (await res.json()) as {
			items: Array<{ id: string; formId: string }>
			total: number
			lockedForms: Array<{ id: string; name: string; responseCount: number }>
		}
		expect(body.items.map((item) => item.id).sort()).toEqual([
			'sub-open-1',
			'sub-open-2',
		])
		expect(body.total).toBe(2)
		expect(body.lockedForms).toEqual([
			{ id: 'secret', name: 'Allergies', responseCount: 1 },
		])
		expect(JSON.stringify(body)).not.toContain('Peanut')
		const count = (await (
			await call('GET', '/count', await mint())
		).json()) as {
			unreadCount: number
		}
		expect(count.unreadCount).toBe(2)
	})

	it('search never reaches into a restricted form', async () => {
		const res = await call('GET', '/forms?search=peanut', await mint())
		const body = (await res.json()) as { items: unknown[] }
		expect(body.items).toEqual([])
	})

	it('a token with the claim reads restricted responses', async () => {
		const res = await call(
			'GET',
			'/forms',
			await mint({ restrictedForms: true }),
		)
		const body = (await res.json()) as {
			items: Array<{ id: string }>
			lockedForms: unknown[]
		}
		expect(body.items.map((item) => item.id)).toContain('sub-secret-1')
		expect(body.lockedForms).toEqual([])
	})

	it('refuses read, draft and export of a restricted response without the claim', async () => {
		const token = await mint()
		expect(
			(await call('PUT', '/forms/sub-secret-1/read', token, { read: true }))
				.status,
		).toBe(404)
		// With the claim the draft route finds the response (and then refuses only
		// because this form has no email field); without it the response is not there.
		expect(
			(await call('POST', '/forms/sub-secret-1/draft', token, { notes: '' }))
				.status,
		).toBe(404)
		expect(
			(
				await call(
					'POST',
					'/forms/sub-secret-1/draft',
					await mint({ restrictedForms: true }),
					{ notes: '' },
				)
			).status,
		).toBe(400)
		expect((await call('GET', '/forms/secret/export', token)).status).toBe(403)
		const granted = await mint({ restrictedForms: true })
		expect((await call('GET', '/forms/secret/export', granted)).status).toBe(
			200,
		)
	})

	it('exports the chosen range as a formula-safe CSV and audits it without values', async () => {
		const res = await call(
			'GET',
			'/forms/open/export?from=2026-03-01&to=2026-03-05',
			await mint(),
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/csv')
		const csv = (await res.text()).replace('﻿', '')
		const lines = csv.trim().split('\r\n')
		expect(lines[0]).toBe('Name,Note,Submitted at,Read')
		expect(lines).toHaveLength(2)
		// The formula is neutralised with a leading quote; Sam's row is the only one in range.
		expect(lines[1]).toContain(`'=HYPERLINK`)
		expect(lines[1]!.startsWith('Sam,')).toBe(true)
		expect(lines[1]).toContain('2026-03-02T10:00:00.000Z')
		expect(lines[1]!.endsWith(',unread')).toBe(true)

		const all = await call('GET', '/forms/open/export', await mint())
		const allCsv = (await all.text()).replace('﻿', '')
		expect(allCsv).toContain(`'+cmd|calc`)

		const db = await getTenantDb(orgId)
		const audits = await db.select().from(formExportAudit)
		expect(audits).toHaveLength(2)
		expect(audits[0]).toMatchObject({
			kind: 'form_responses',
			targetId: 'open',
			operatorId: 'user-1',
			rowCount: 1,
		})
		expect(JSON.stringify(audits)).not.toContain('Sam')
	})

	it('refuses a bad range and a token from another organization or scope', async () => {
		expect(
			(await call('GET', '/forms/open/export?from=nonsense', await mint()))
				.status,
		).toBe(400)
		// A token for the other organization finds none of this organization's forms.
		const other = await call(
			'GET',
			'/forms/open/export',
			await mint({ org: otherOrgId }),
		)
		expect(other.status).toBe(404)
		const db = await getTenantDb(otherOrgId)
		expect(await db.select().from(formExportAudit)).toHaveLength(0)
		// Wrong scope and missing token never reach the data.
		expect(
			(await call('GET', '/forms/open/export', await mint({ scope: 'people' })))
				.status,
		).toBe(401)
		const anon = await app.request('/operator/mailbox/forms/open/export')
		expect(anon.status).toBe(401)
	})
})
