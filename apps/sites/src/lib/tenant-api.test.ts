import { beforeEach, describe, expect, it, vi } from 'vitest'

const urls = vi.hoisted(() => ({ us: '', ksa: '' }))

vi.mock('~/lib/worker-env', () => ({
	getTenantApiUrl: () => urls.us,
	getTenantApiUrlKsa: () => urls.ksa,
}))

import { getTenantApiUrl } from './tenant-api.ts'

describe('getTenantApiUrl', () => {
	beforeEach(() => {
		urls.us = 'https://tenant-us.example.com'
		urls.ksa = 'https://tenant-ksa.example.com'
	})

	it('picks the node of the organization region', () => {
		expect(getTenantApiUrl('us')).toBe('https://tenant-us.example.com')
		expect(getTenantApiUrl(null)).toBe('https://tenant-us.example.com')
		expect(getTenantApiUrl('ksa')).toBe('https://tenant-ksa.example.com')
		expect(getTenantApiUrl('KSA')).toBe('https://tenant-ksa.example.com')
	})

	it('never hands a KSA organization the US node', () => {
		urls.ksa = ''

		expect(getTenantApiUrl('ksa')).toBeNull()
		expect(getTenantApiUrl('us')).toBe('https://tenant-us.example.com')
	})
})
