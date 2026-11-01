import { DISCOUNTS_FLAG_KEYS } from '@repo/common/discounts-flags'
import { describe, expect, it } from 'vitest'
import { discountSiteCacheTargets } from './sites-cache-purge.server.ts'

const enabled = DISCOUNTS_FLAG_KEYS.enabled

describe('discountSiteCacheTargets', () => {
	it('purges the organization for an organization-level discount flag', () => {
		expect(
			discountSiteCacheTargets([
				{ key: enabled, level: 'organization', organizationId: 'org_a' },
			]),
		).toEqual([{ organizationId: 'org_a' }])
	})

	it('rebuilds every menu for a system-level discount flag', () => {
		expect(
			discountSiteCacheTargets([{ key: enabled, level: 'system' }]),
		).toEqual([{ scope: 'all-menus' }])
	})

	it('also clears the organization a moved flag left, once each', () => {
		expect(
			discountSiteCacheTargets([
				{ key: enabled, level: 'organization', organizationId: 'org_a' },
				{ key: enabled, level: 'organization', organizationId: 'org_b' },
				{ key: enabled, level: 'organization', organizationId: 'org_b' },
			]),
		).toEqual([{ organizationId: 'org_a' }, { organizationId: 'org_b' }])
	})

	it('clears the old placement when the key changes away from discounts', () => {
		expect(
			discountSiteCacheTargets([
				{ key: enabled, level: 'organization', organizationId: 'org_a' },
				{
					key: 'reservations.enabled',
					level: 'organization',
					organizationId: 'org_a',
				},
			]),
		).toEqual([{ organizationId: 'org_a' }])
	})

	it('ignores other flags, user-level flags and missing rows', () => {
		expect(
			discountSiteCacheTargets([
				{ key: 'reservations.enabled', level: 'system' },
				{ key: enabled, level: 'user' },
				{ key: enabled, level: 'organization', organizationId: null },
				undefined,
			]),
		).toEqual([])
	})
})
