import { parseWithZod } from '@conform-to/zod'
import { describe, expect, it } from 'vitest'
import { SiteAnalyticsSchema } from './site-analytics-card'

function submit(fields: Record<string, string>) {
	const formData = new FormData()
	formData.set('organizationId', 'org_1')
	for (const name of [
		'facebookPixelId',
		'googleTagManagerId',
		'googleAnalyticsId',
		'tiktokPixelId',
	]) {
		formData.set(name, fields[name] ?? '')
	}
	return parseWithZod(formData, { schema: SiteAnalyticsSchema })
}

describe('SiteAnalyticsSchema', () => {
	it('accepts one ID with the other fields left blank', () => {
		const submission = submit({ googleAnalyticsId: 'G-ABC123' })

		expect(submission.status).toBe('success')
		expect(submission.status === 'success' && submission.value).toMatchObject({
			googleAnalyticsId: 'G-ABC123',
		})
	})

	it('accepts every field blank to disable all integrations', () => {
		expect(submit({}).status).toBe('success')
	})

	it('treats a whitespace-only field as blank', () => {
		const submission = submit({ googleTagManagerId: '   ' })

		expect(submission.status).toBe('success')
		expect(
			submission.status === 'success' && submission.value.googleTagManagerId,
		).toBeFalsy()
	})

	it('only reports the filled-in field that is invalid', () => {
		const submission = submit({ googleAnalyticsId: 'not a real id' })

		expect(submission.status).toBe('error')
		expect(submission.reply().error).toEqual({
			googleAnalyticsId: [
				'Enter a valid Measurement ID like G-XXXXXXXXXX, or leave blank to disable.',
			],
		})
	})
})
