import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	websiteForms,
	websiteFormSubmissions,
	mailboxReadReceipts,
} from '@repo/tenant-db'
import { count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { draftMailboxReply, isMailboxAIConfigured } from '../lib/mailbox-ai.ts'
import { mailboxRoutes } from './mailbox.ts'
import { operatorRoutes } from './operator.ts'

vi.mock('../lib/origin.ts', () => ({ findActiveOrganizationById: vi.fn() }))
vi.mock('../lib/mailbox-ai.ts', () => ({
	isMailboxAIConfigured: vi.fn(() => false),
	draftMailboxReply: vi.fn(),
}))

const orgId = 'clw9x0a12000008l00mailbox1'
const secret = 'test-mailbox-operator-secret-12345'
const fields = [
	{ id: 'name', type: 'name', label: 'Name', required: false },
	{ id: 'email', type: 'email', label: 'Email', required: false },
	{ id: 'message', type: 'textarea', label: 'Message', required: true },
] as const

describe('regional mailbox', () => {
	let directory: string
	let app: Hono
	let submissionId: string
	async function token(
		operatorId = 'operator-a',
		scope: string | null = 'mailbox',
		organizationId = orgId,
	) {
		return new SignJWT({
			orgId: organizationId,
			role: 'operator',
			scope: scope ?? undefined,
		})
			.setSubject(operatorId)
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(secret))
	}
	async function call(
		pathname: string,
		operatorId = 'operator-a',
		init: RequestInit = {},
	) {
		return app.request(`/operator/mailbox${pathname}`, {
			...init,
			headers: {
				Authorization: `Bearer ${await token(operatorId)}`,
				'Content-Type': 'application/json',
			},
		})
	}
	beforeEach(async () => {
		vi.stubEnv('TENANT_OPERATOR_TOKEN', secret)
		vi.stubEnv('DATA_REGION', 'us')
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-test-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.mocked(isMailboxAIConfigured).mockReturnValue(false)
		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		const [form] = await db
			.insert(websiteForms)
			.values({ name: 'Contact us', fields })
			.returning()
		const [submission] = await db
			.insert(websiteFormSubmissions)
			.values({
				formId: form!.id,
				values: {
					name: 'Rana',
					email: 'rana@example.com',
					message: 'Do you deliver on weekends?',
				},
			})
			.returning()
		submissionId = submission!.id
		app = new Hono()
			.route('/operator/mailbox', mailboxRoutes)
			.route('/operator', operatorRoutes)
	})
	afterEach(async () => {
		await destroyTenantDb(orgId)
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.clearAllMocks()
	})
	it('requires a mailbox-scoped token and an operator identity', async () => {
		expect((await app.request('/operator/mailbox/count')).status).toBe(401)
		const generic = await token('operator-a', null)
		expect(
			(
				await app.request('/operator/mailbox/count', {
					headers: { Authorization: `Bearer ${generic}` },
				})
			).status,
		).toBe(401)
		const missingIdentity = await new SignJWT({
			orgId,
			role: 'operator',
			scope: 'mailbox',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.sign(new TextEncoder().encode(secret))
		expect(
			(
				await app.request('/operator/mailbox/count', {
					headers: { Authorization: `Bearer ${missingIdentity}` },
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request('/operator/customers', {
					headers: { Authorization: `Bearer ${await token()}` },
				})
			).status,
		).toBe(401)
	})
	it('keeps read receipts independent and idempotent for each operator', async () => {
		expect(await (await call('/count')).json()).toEqual({ unreadCount: 1 })
		const read = () =>
			call(`/forms/${submissionId}/read`, 'operator-a', {
				method: 'PUT',
				body: JSON.stringify({ read: true }),
			})
		expect((await read()).status).toBe(200)
		expect((await read()).status).toBe(200)
		expect(await (await call('/count')).json()).toEqual({ unreadCount: 0 })
		expect(await (await call('/count', 'operator-b')).json()).toEqual({
			unreadCount: 1,
		})
		const db = await getTenantDb(orgId)
		expect(
			(await db.select({ value: count() }).from(mailboxReadReceipts))[0]?.value,
		).toBe(1)
		await call(`/forms/${submissionId}/read`, 'operator-a', {
			method: 'PUT',
			body: JSON.stringify({ read: false }),
		})
		expect(await (await call('/count')).json()).toEqual({ unreadCount: 1 })
	})
	it('lists submissions across forms with literal search, pagination and unread filters', async () => {
		const db = await getTenantDb(orgId)
		const [form] = await db
			.insert(websiteForms)
			.values({ name: 'Feedback', fields })
			.returning()
		await db.insert(websiteFormSubmissions).values(
			Array.from({ length: 51 }, (ignoredValue, index) => ({
				formId: form!.id,
				values: { message: `Feedback ${index}` },
			})),
		)
		const first = await (await call('/forms')).json()
		expect(first.items).toHaveLength(50)
		expect(first.total).toBe(52)
		expect((await (await call('/forms?page=2')).json()).items).toHaveLength(2)
		expect(
			(await (await call('/forms?search=weekends')).json()).items[0].id,
		).toBe(submissionId)
		expect((await (await call('/forms?search=%25')).json()).total).toBe(0)
		expect((await (await call('/forms?search=message')).json()).total).toBe(0)
		await call(`/forms/${submissionId}/read`, 'operator-a', {
			method: 'PUT',
			body: JSON.stringify({ read: true }),
		})
		expect((await (await call('/forms?unread=true')).json()).total).toBe(51)
		expect(
			(await (await call('/forms', 'operator-b')).json()).unreadCount,
		).toBe(52)
		expect((await call('/forms?page=-1')).status).toBe(400)
	})
	it('rejects invalid read mutations, missing submissions and other regions', async () => {
		expect(
			(
				await call(`/forms/${submissionId}/read`, 'operator-a', {
					method: 'PUT',
					body: '{"read":"yes"}',
				})
			).status,
		).toBe(400)
		expect(
			(
				await call('/forms/missing/read', 'operator-a', {
					method: 'PUT',
					body: '{"read":true}',
				})
			).status,
		).toBe(404)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			dataRegion: 'ksa',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		expect((await call('/forms')).status).toBe(404)
		vi.mocked(findActiveOrganizationById).mockResolvedValue(null)
		expect((await call('/count')).status).toBe(404)
	})
	it('cascades read receipts when a submission is removed', async () => {
		await call(`/forms/${submissionId}/read`, 'operator-a', {
			method: 'PUT',
			body: '{"read":true}',
		})
		const db = await getTenantDb(orgId)
		await db
			.delete(websiteFormSubmissions)
			.where(eq(websiteFormSubmissions.id, submissionId))
		expect(
			(await db.select({ value: count() }).from(mailboxReadReceipts))[0]?.value,
		).toBe(0)
	})
	it('drafts only when configured and an email is present, omitting identity fields', async () => {
		expect(
			(
				await call(`/forms/${submissionId}/draft`, 'operator-a', {
					method: 'POST',
					body: '{}',
				})
			).status,
		).toBe(503)
		vi.mocked(isMailboxAIConfigured).mockReturnValue(true)
		vi.mocked(draftMailboxReply).mockResolvedValue(
			'Thank you for reaching out. Could you share your location?',
		)
		const response = await call(`/forms/${submissionId}/draft`, 'operator-a', {
			method: 'POST',
			body: '{"notes":"Ask for their location"}',
		})
		expect(response.status).toBe(200)
		expect((await response.json()).message).toContain('Thank you')
		expect(draftMailboxReply).toHaveBeenCalledWith({
			form: 'Contact us',
			answers: [{ question: 'Message', answer: 'Do you deliver on weekends?' }],
			notes: 'Ask for their location',
		})
		const db = await getTenantDb(orgId)
		await db
			.update(websiteFormSubmissions)
			.set({ values: { message: 'Hello' } })
			.where(eq(websiteFormSubmissions.id, submissionId))
		expect(
			(
				await call(`/forms/${submissionId}/draft`, 'operator-a', {
					method: 'POST',
					body: '{}',
				})
			).status,
		).toBe(400)
	})
})
