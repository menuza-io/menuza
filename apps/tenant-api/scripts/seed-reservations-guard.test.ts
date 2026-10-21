import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	assertLocalSeedEnvironment,
	assertRegionUnchanged,
	resolveSeedSlug,
} from './seed-reservations-guard.ts'

const local = {
	nodeEnv: 'development',
	databaseUrl: 'file:./db/data.db',
	tenantDbDir: undefined,
}

describe('seed-reservations guard', () => {
	it('accepts the demo venues and an explicitly allowed slug only', () => {
		expect(resolveSeedSlug({ slug: 'acme' })).toBe('acme')
		expect(resolveSeedSlug({ slug: 'riyadh-grill' })).toBe('riyadh-grill')
		expect(() => resolveSeedSlug({ slug: 'real-customer' })).toThrow(/Refusing/)
		expect(
			resolveSeedSlug({ slug: 'my-dev-org', allow: 'x, my-dev-org' }),
		).toBe('my-dev-org')
		expect(() => resolveSeedSlug({ slug: undefined })).toThrow(/Refusing/)
		expect(() => resolveSeedSlug({ slug: 'constructor' })).toThrow(/Refusing/)
	})

	it('treats an unset or production NODE_ENV as production', () => {
		expect(() => assertLocalSeedEnvironment(local)).not.toThrow()
		expect(() =>
			assertLocalSeedEnvironment({ ...local, nodeEnv: 'test' }),
		).not.toThrow()
		for (const nodeEnv of [undefined, '', 'production', 'staging']) {
			expect(() => assertLocalSeedEnvironment({ ...local, nodeEnv })).toThrow(
				/NODE_ENV/,
			)
		}
	})

	it('refuses a remote control-plane database and a non-local tenant folder', () => {
		expect(() =>
			assertLocalSeedEnvironment({
				...local,
				databaseUrl: 'libsql://prod.turso.io',
			}),
		).toThrow(/DATABASE_URL/)
		expect(() =>
			assertLocalSeedEnvironment({ ...local, tenantDbDir: '/data/tenants' }),
		).toThrow(/TENANT_DB_DIR/)
		expect(() =>
			assertLocalSeedEnvironment({
				...local,
				tenantDbDir: path.join(os.tmpdir(), 'seed'),
			}),
		).not.toThrow()
		expect(() =>
			assertLocalSeedEnvironment({
				...local,
				tenantDbDir: path.resolve(
					import.meta.dirname,
					'../../../packages/database/db/ksa',
				),
			}),
		).not.toThrow()
	})

	it('never moves an existing organization to another region', () => {
		expect(() =>
			assertRegionUnchanged({ slug: 'acme', existing: 'ksa', preset: 'us' }),
		).toThrow(/data region/)
		expect(() =>
			assertRegionUnchanged({ slug: 'acme', existing: 'us', preset: 'us' }),
		).not.toThrow()
		expect(() =>
			assertRegionUnchanged({ slug: 'acme', existing: null, preset: 'us' }),
		).not.toThrow()
	})
})
