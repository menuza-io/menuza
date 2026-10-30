import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	isAllowedBrowserOrigin,
	isOperatorControlPlaneOrigin,
	resolveOrganizationForBrowserAuth,
	resolveOrganizationForPublicOrigin,
	resolveOriginBinding,
} from './origin.ts'

const { select } = vi.hoisted(() => ({ select: vi.fn() }))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return { ...actual, db: { select } }
})

const organization = {
	id: 'clw9x0a12000008l00nodeenv1',
	slug: 'acme',
	customDomain: null,
	dataRegion: 'us',
}

const originalNodeEnv = process.env.NODE_ENV
let port = 4100

function setNodeEnv(value: string | undefined) {
	if (value === undefined) delete process.env.NODE_ENV
	else process.env.NODE_ENV = value
}

beforeEach(() => {
	vi.stubEnv('APP_URL', 'https://app.example.com')
	select.mockImplementation(() => {
		throw new Error('no local control plane')
	})
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(organization)))
})

afterEach(() => {
	setNodeEnv(originalNodeEnv)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe.each([
	{ label: 'unset', value: undefined },
	{ label: 'production', value: 'production' },
	{ label: 'an unknown value', value: 'staging' },
])('NODE_ENV $label counts as production', ({ value }) => {
	beforeEach(() => setNodeEnv(value))

	it('refuses plain http tenant origins', () => {
		expect(resolveOriginBinding(`http://acme.${getBrandDomain()}`)).toEqual({
			kind: 'none',
		})
	})

	it('refuses localhost browser origins', async () => {
		port += 1
		await expect(
			isAllowedBrowserOrigin(`http://localhost:${port}`),
		).resolves.toBe(false)
	})

	it('refuses App and Admin over plain http', () => {
		expect(
			isOperatorControlPlaneOrigin(`http://app.${getLocalDomain()}:2999`),
		).toBe(false)
		expect(
			isOperatorControlPlaneOrigin(`http://admin.${getLocalDomain()}:2999`),
		).toBe(false)
	})

	it('ignores slug hints from a request without a tenant origin', async () => {
		await expect(
			resolveOrganizationForPublicOrigin(undefined, { slug: 'acme' }),
		).resolves.toBeNull()
		await expect(
			resolveOrganizationForBrowserAuth(undefined, { slug: 'acme' }),
		).resolves.toBeNull()
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe.each([
	{ label: 'development', value: 'development' },
	{ label: 'test', value: 'test' },
])('NODE_ENV $label is local', ({ value }) => {
	beforeEach(() => setNodeEnv(value))

	it('accepts plain http tenant origins and localhost', async () => {
		expect(
			resolveOriginBinding(`http://acme.${getBrandDomain()}`).kind,
		).not.toBe('none')
		port += 1
		await expect(
			isAllowedBrowserOrigin(`http://localhost:${port}`),
		).resolves.toBe(true)
		expect(
			isOperatorControlPlaneOrigin(`http://app.${getLocalDomain()}:2999`),
		).toBe(true)
	})

	it('honors slug hints for local tools', async () => {
		await expect(
			resolveOrganizationForPublicOrigin(undefined, { slug: 'acme' }),
		).resolves.toMatchObject({ id: organization.id })
	})
})
