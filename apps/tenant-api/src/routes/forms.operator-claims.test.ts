import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formOperatorRoutes } from './forms.ts'

const orgId = 'clw9x0a12000008l00test77'
const operatorSecret = 'test-operator-secret-123456789'

function mint(claims: {
	canUpdate?: boolean
	canDelete?: boolean
	restrictedForms?: boolean
}) {
	return new SignJWT({ orgId, role: 'operator', ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorSecret))
}

const validForm = {
	name: 'Contact',
	fields: [{ id: 'email', type: 'email', label: 'Email', required: true }],
	successMessage: 'Thanks',
}

describe('operator form routes honor the write claims', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-forms-claims-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/operator/forms', formOperatorRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function call(method: string, route: string, token: string, body?: unknown) {
		return app.request(`/operator/forms${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	it('lets a read-only token list forms but refuses create, update and delete', async () => {
		const readOnly = await mint({})
		expect((await call('GET', '', readOnly)).status).toBe(200)
		expect((await call('POST', '', readOnly, validForm)).status).toBe(403)
		expect((await call('PUT', '/f1', readOnly, validForm)).status).toBe(403)
		expect((await call('DELETE', '/f1', readOnly)).status).toBe(403)
		expect((await call('DELETE', '/f1/submissions/s1', readOnly)).status).toBe(
			403,
		)
	})

	it('an update token can create but not delete', async () => {
		const updater = await mint({ canUpdate: true })
		expect((await call('POST', '', updater, validForm)).status).toBe(201)
		expect((await call('DELETE', '/f1', updater)).status).toBe(403)
	})

	it('a delete-capable token can delete', async () => {
		const deleter = await mint({ canUpdate: true, canDelete: true })
		const created = await call('POST', '', deleter, validForm)
		const { form } = (await created.json()) as { form: { id: string } }
		expect((await call('DELETE', `/${form.id}`, deleter)).status).toBe(200)
		expect((await call('DELETE', `/${form.id}`, deleter)).status).toBe(404)
		expect((await call('DELETE', '/missing', deleter)).status).toBe(404)
	})
})

describe('restricted forms on the operator routes (#357)', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-forms-restr-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/operator/forms', formOperatorRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function call(method: string, route: string, token: string, body?: unknown) {
		return app.request(`/operator/forms${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	async function restrictedForm() {
		const owner = await mint({ canUpdate: true, restrictedForms: true })
		const created = await call('POST', '', owner, {
			...validForm,
			restricted: true,
		})
		expect(created.status).toBe(201)
		return ((await created.json()) as { form: { id: string } }).form.id
	}

	it('a token without the claim cannot read the responses of a restricted form', async () => {
		const id = await restrictedForm()
		const plain = await mint({ canUpdate: true })
		expect((await call('GET', `/${id}/submissions`, plain)).status).toBe(403)
		const reader = await mint({ restrictedForms: true })
		expect((await call('GET', `/${id}/submissions`, reader)).status).toBe(200)
	})

	it('the list still shows the form and its count to everyone', async () => {
		const id = await restrictedForm()
		const res = await call('GET', '', await mint({}))
		const body = (await res.json()) as {
			forms: Array<{ id: string; restricted: boolean; submissionCount: number }>
		}
		expect(body.forms.find((form) => form.id === id)).toMatchObject({
			restricted: true,
			submissionCount: 0,
		})
	})

	it('turning Restricted off needs the permission, other edits do not', async () => {
		const id = await restrictedForm()
		const editor = await mint({ canUpdate: true })
		// Editing while it stays restricted is open to form editors.
		const rename = await call('PUT', `/${id}`, editor, {
			...validForm,
			name: 'Renamed',
			restricted: true,
		})
		expect(rename.status).toBe(200)
		const lift = await call('PUT', `/${id}`, editor, {
			...validForm,
			restricted: false,
		})
		expect(lift.status).toBe(403)
		const holder = await mint({ canUpdate: true, restrictedForms: true })
		const lifted = await call('PUT', `/${id}`, holder, {
			...validForm,
			restricted: false,
		})
		expect(lifted.status).toBe(200)
		expect(
			((await lifted.json()) as { form: { restricted: boolean } }).form
				.restricted,
		).toBe(false)
	})

	it('a restricted form and its responses are deleted only by readers', async () => {
		const id = await restrictedForm()
		const deleter = await mint({ canUpdate: true, canDelete: true })
		expect((await call('DELETE', `/${id}`, deleter)).status).toBe(403)
		expect((await call('DELETE', `/${id}/submissions/x`, deleter)).status).toBe(
			403,
		)
		const holder = await mint({
			canUpdate: true,
			canDelete: true,
			restrictedForms: true,
		})
		expect((await call('DELETE', `/${id}`, holder)).status).toBe(200)
	})

	it('rejects a condition that points below its field', async () => {
		const owner = await mint({ canUpdate: true })
		const res = await call('POST', '', owner, {
			name: 'Bad',
			successMessage: 'ok',
			fields: [
				{
					id: 'address',
					type: 'address',
					label: 'Address',
					required: false,
					showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
				},
				{
					id: 'fulfilment',
					type: 'single_choice',
					label: 'How',
					required: false,
					options: ['Delivery'],
				},
			],
		})
		expect(res.status).toBe(400)
	})
})
