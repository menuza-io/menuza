import { setupI18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { sanitizeJobDescription } from '../sanitize.ts'
import { employmentLabel, payLine } from './labels.ts'
import { renderQrSvg } from './qr.ts'
import { jobPostingStructuredData } from './seo.ts'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })

describe('payLine', () => {
	const base = { currency: 'USD', payType: 'hourly' as const }

	it('formats a range, a fixed rate and no pay', () => {
		expect(
			payLine(i18n, 'en', { ...base, payMinMinor: 1800, payMaxMinor: 2200 }),
		).toBe('$18 – $22 per hour')
		expect(
			payLine(i18n, 'en', { ...base, payMinMinor: 1850, payMaxMinor: 1850 }),
		).toBe('$18.50 per hour')
		expect(
			payLine(i18n, 'en', {
				...base,
				payType: 'none',
				payMinMinor: null,
				payMaxMinor: null,
			}),
		).toBeNull()
	})

	it('handles a one-sided range and other periods and currencies', () => {
		expect(
			payLine(i18n, 'en', {
				currency: 'SAR',
				payType: 'monthly',
				payMinMinor: 500000,
				payMaxMinor: null,
			}),
		).toMatch(/5,000.*per month/)
	})
})

describe('labels', () => {
	it('names every employment type', () => {
		expect(employmentLabel(i18n, 'full_time')).toBe('Full time')
		expect(employmentLabel(i18n, 'internship')).toBe('Internship')
	})
})

describe('sanitizeJobDescription', () => {
	it('keeps posting formatting and drops everything unsafe', () => {
		const html =
			'<h2>About</h2><p>We <strong>cook</strong>.</p><ul><li>Fast</li></ul>'
		expect(sanitizeJobDescription(html)).toBe(html)
		const clean = sanitizeJobDescription(
			'<p onclick="x()">Hi</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><style>p{}</style>',
		)
		expect(clean).not.toMatch(/script|onerror|onclick|javascript:|<img|style/)
		expect(clean).toContain(
			'<a href="https://ok.example" target="_blank" rel="noopener noreferrer nofollow">ok</a>',
		)
		expect(sanitizeJobDescription(null)).toBe('')
	})
})

describe('renderQrSvg', () => {
	it('draws a black-on-white svg for a link', async () => {
		const svg = await renderQrSvg('https://acme.example/careers/line-cook')
		expect(svg).toMatch(/^<svg/)
		expect(svg).toContain('#000000')
		expect(svg).toContain('#ffffff')
	})
})

describe('jobPostingStructuredData', () => {
	const posting = {
		slug: 'line-cook',
		title: 'Line cook',
		positionName: 'Cook',
		employmentType: 'full_time' as const,
		payType: 'hourly' as const,
		payMinMinor: 1800,
		payMaxMinor: 2200,
		currency: 'USD',
		descriptionHtml: '<p>Cook.</p><script>alert(1)</script>',
		questions: [],
		isGeneral: false,
		datePosted: '2026-10-01T00:00:00.000Z',
		validThrough: null,
	}

	it('is valid JSON, carries pay, and cannot close its script tag', () => {
		const text = jobPostingStructuredData({
			posting: {
				...posting,
				title: '</script><script>alert(1)</script>',
			},
			organizationName: 'Acme Diner',
			siteUrl: 'https://acme.example',
			url: 'https://acme.example/careers/line-cook',
			locale: 'en',
		})
		expect(text).not.toContain('</script>')
		const data = JSON.parse(text)
		expect(data['@type']).toBe('JobPosting')
		expect(data.baseSalary.value.minValue).toBe(18)
		expect(data.description).toBe('<p>Cook.</p>')
		expect(data.hiringOrganization.name).toBe('Acme Diner')
		expect(data.inLanguage).toBe('en')
	})

	it('claims a direct application only when the page has the form', () => {
		const input = {
			posting,
			organizationName: 'Acme Diner',
			siteUrl: 'https://acme.example',
			url: 'https://acme.example/careers/line-cook',
			locale: 'en',
		}
		expect(JSON.parse(jobPostingStructuredData(input)).directApply).toBe(false)
		expect(
			JSON.parse(jobPostingStructuredData({ ...input, directApply: true }))
				.directApply,
		).toBe(true)
	})
})
