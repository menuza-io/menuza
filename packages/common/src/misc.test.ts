import { faker } from '@faker-js/faker'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { getDomainUrl, getErrorMessage, formatDate } from '@repo/common'
import { getBrandDomain } from '@repo/config/brand'

describe('formatDate', () => {
	test('formats Date object correctly', () => {
		const date = new Date('2023-01-01T12:00:00Z')
		// Note: The specific output depends on the timezone of the environment running the test
		// Using a regex to verify the format roughly matches "Jan 1, 2023, 12:00 PM"
		expect(formatDate(date)).toMatch(/Jan 1, 2023, \d{1,2}:\d{2} [AP]M/)
	})

	test('formats ISO string correctly', () => {
		const dateString = '2023-01-01T12:00:00Z'
		expect(formatDate(dateString)).toMatch(/Jan 1, 2023, \d{1,2}:\d{2} [AP]M/)
	})

	test('formats timestamp number correctly', () => {
		const timestamp = 1672574400000 // 2023-01-01T12:00:00Z
		expect(formatDate(timestamp)).toMatch(/Jan 1, 2023, \d{1,2}:\d{2} [AP]M/)
	})
})

describe('getErrorMessage', () => {
	const consoleError = vi.spyOn(console, 'error')

	beforeEach(() => {
		consoleError.mockImplementation(() => {})
	})

	afterEach(() => {
		consoleError.mockReset()
	})

	test('Error object returns message', () => {
		const message = faker.lorem.words(2)
		expect(getErrorMessage(new Error(message))).toBe(message)
	})

	test('String returns itself', () => {
		const message = faker.lorem.words(2)
		expect(getErrorMessage(message)).toBe(message)
	})

	test('undefined falls back to Unknown', () => {
		expect(getErrorMessage(undefined)).toBe('Unknown Error')
		expect(consoleError).toHaveBeenCalledWith(
			'Unable to get error message for error',
			undefined,
		)
		expect(consoleError).toHaveBeenCalledTimes(1)
	})
})

describe('getDomainUrl', () => {
	test('returns correct url for http', () => {
		const url = 'http://example.com'
		const request = new Request(url)
		expect(getDomainUrl(request)).toBe(url)
	})

	test('returns correct url for https', () => {
		const url = 'https://example.com'
		const request = new Request(url)
		expect(getDomainUrl(request)).toBe(url)
	})

	test('respects X-Forwarded-Proto on trusted brand hosts', () => {
		const domain = getBrandDomain()
		const url = `http://${domain}`
		const request = new Request(url, {
			headers: { 'X-Forwarded-Proto': 'https' },
		})
		expect(getDomainUrl(request)).toBe(`https://${domain}`)
	})

	test('ignores X-Forwarded-Proto on untrusted hosts', () => {
		const url = 'http://example.com'
		const request = new Request(url, {
			headers: { 'X-Forwarded-Proto': 'https' },
		})
		expect(getDomainUrl(request)).toBe('http://example.com')
	})

	test('forces https for the brand domain', () => {
		const domain = getBrandDomain()
		const url = `http://${domain}`
		const request = new Request(url)
		expect(getDomainUrl(request)).toBe(`https://${domain}`)
	})

	test('forces https for a brand subdomain', () => {
		const domain = getBrandDomain()
		const url = `http://sub.${domain}`
		const request = new Request(url)
		expect(getDomainUrl(request)).toBe(`https://sub.${domain}`)
	})
})
