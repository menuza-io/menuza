import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { provisionRoutes } from './provision.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	organizationFromProvisionPayload: vi.fn(() => null),
}))

const orgId = 'clw9x0a12000008l00deprov01'
const internalToken = 'test-internal-token-123456789'
const recordingEnv = {
	RECORDING_S3_BUCKET: 'recordings',
	RECORDING_S3_ENDPOINT: 'https://s3.example.test',
	RECORDING_S3_ACCESS_KEY: 'access',
	RECORDING_S3_SECRET: 'secret',
}

describe('deprovision', () => {
	let tempDir: string
	let app: Hono
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-deprov-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		Object.assign(process.env, recordingEnv)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'deprov',
			name: 'Deprov',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		fetchSpy = vi.spyOn(globalThis, 'fetch')
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/api', provisionRoutes)
	})

	afterEach(() => {
		for (const key of Object.keys(recordingEnv)) process.env[key] = ''
		fetchSpy.mockRestore()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const dbFile = () => path.join(tempDir, `tenant_${orgId}.db`)

	const deprovision = () =>
		app.request('/api/deprovision', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${internalToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ orgId }),
		})

	it('deletes the org recordings before destroying the database', async () => {
		const key = `voice-recordings/${orgId}/call-1.ogg`
		fetchSpy.mockImplementation(async (_url, init) => {
			if ((init as RequestInit).method === 'DELETE') {
				// The database still exists while recordings are deleted.
				expect(fs.existsSync(dbFile())).toBe(true)
				return new Response(null, { status: 204 })
			}
			return new Response(
				`<ListBucketResult><Contents><Key>${key}</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
			)
		})
		const res = await deprovision()
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			success: true,
			recordings: 'deleted',
		})
		expect(fetchSpy).toHaveBeenCalledWith(
			`https://s3.example.test/recordings/${key}`,
			expect.objectContaining({ method: 'DELETE' }),
		)
		expect(fs.existsSync(dbFile())).toBe(false)
	})

	it('still destroys the database when storage fails or is not configured', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		fetchSpy.mockResolvedValue(new Response(null, { status: 503 }))
		const failed = await deprovision()
		expect(failed.status).toBe(200)
		expect(await failed.json()).toMatchObject({ recordings: 'failed' })
		expect(fs.existsSync(dbFile())).toBe(false)
		expect(errors).toHaveBeenCalledWith(
			'Could not delete every recording of a deprovisioned org',
			expect.objectContaining({ orgId }),
		)
		errors.mockRestore()

		await provisionTenantDb(orgId)
		fetchSpy.mockClear()
		for (const key of Object.keys(recordingEnv)) process.env[key] = ''
		const skipped = await deprovision()
		expect(await skipped.json()).toMatchObject({
			recordings: 'not_configured',
		})
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(fs.existsSync(dbFile())).toBe(false)
	})
})
