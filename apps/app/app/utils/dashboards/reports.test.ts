import {
	createReportDefinition,
	emptyFilterGroup,
	organizationTemplates,
	templateCategories,
	type ReportDefinition,
} from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	findOrganizationTemplate,
	isReportAccessDenied,
	reportBlockHref,
	reportTemplateGroups,
	resolveReportBlock,
	type ReportBlockData,
} from './reports.ts'

function definition(title: string): ReportDefinition {
	return createReportDefinition({
		subject: 'notes',
		timeframe: { field: 'createdAt', preset: 'last_30_days' },
		groupBy: ['status'],
		timeBucket: 'month',
		columns: [],
		filters: emptyFilterGroup(),
		visualization: {
			chartStyle: 'bar',
			measure: 'count',
			sortBy: 'value_desc',
			hideCounts: false,
		},
		settings: { title, notes: '', timezone: 'user' },
	})
}

function reportData(
	savedReports: ReportBlockData['savedReports'] = {},
): ReportBlockData {
	return {
		savedReports,
		runUrl: '/acme/reports/run',
		tokenUrl: '/acme/reports/token',
		tenantApiUrl: 'http://localhost:3007',
	}
}

describe('reportBlockHref', () => {
	it('opens a saved report on its own page', () => {
		expect(reportBlockHref('acme', { source: 'saved', reportId: 'r1' })).toBe(
			'/acme/reports/r1',
		)
	})

	it('opens a template in the report builder like the reports page does', () => {
		expect(
			reportBlockHref('acme', {
				source: 'template',
				templateId: 'notes-by-status',
			}),
		).toBe('/acme/reports/new?template=notes-by-status')
	})
})

describe('reportTemplateGroups', () => {
	it('lists every organization template once, grouped by category', () => {
		const templates = organizationTemplates()
		const groups = reportTemplateGroups()

		expect(groups.map((group) => group.category)).toEqual(
			templateCategories(templates),
		)
		expect(
			groups.flatMap((group) => group.templates.map((item) => item.id)),
		).toEqual(
			templateCategories(templates).flatMap((category) =>
				templates
					.filter((template) => template.category === category)
					.map((template) => template.id),
			),
		)
		const notesByStatus = groups
			.flatMap((group) => group.templates)
			.find((item) => item.id === 'notes-by-status')
		expect(notesByStatus).toMatchObject({
			title: 'Notes by status',
			subjectLabel: 'Notes',
		})
	})
})

describe('resolveReportBlock', () => {
	it('shows a template once the report data is loaded', () => {
		const config = {
			source: 'template',
			templateId: 'notes-by-status',
		} as const
		const template = findOrganizationTemplate('notes-by-status')!

		expect(
			resolveReportBlock(config, { orgSlug: 'acme', reports: null }),
		).toEqual({
			status: 'loading',
			title: 'Notes by status',
			subjectLabel: 'Notes',
			href: '/acme/reports/new?template=notes-by-status',
		})
		const ready = resolveReportBlock(config, {
			orgSlug: 'acme',
			reports: reportData(),
		})
		expect(ready).toEqual({
			status: 'ready',
			title: 'Notes by status',
			subjectLabel: 'Notes',
			href: '/acme/reports/new?template=notes-by-status',
			definition: template.definition,
		})
		// The same definition object every time, so the report does not rerun.
		expect(
			resolveReportBlock(config, { orgSlug: 'acme', reports: reportData() }),
		).toMatchObject({ definition: template.definition })
	})

	it('treats an unknown template as not found', () => {
		expect(
			resolveReportBlock(
				{ source: 'template', templateId: 'gone' },
				{ orgSlug: 'acme', reports: reportData() },
			),
		).toEqual({
			status: 'not-found',
			title: null,
			subjectLabel: null,
			href: null,
		})
	})

	it('shows a saved report with its title and definition', () => {
		const saved = definition('Weekly notes')
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r1' },
				{
					orgSlug: 'acme',
					reports: reportData({
						r1: { title: 'Weekly notes', definition: saved },
					}),
				},
			),
		).toEqual({
			status: 'ready',
			title: 'Weekly notes',
			subjectLabel: 'Notes',
			href: '/acme/reports/r1',
			definition: saved,
		})
	})

	it('waits for a saved report added since the page loaded', () => {
		const options = [{ id: 'r2', title: 'New report', subjectLabel: 'Notes' }]
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r2' },
				{ orgSlug: 'acme', reports: null, savedReportOptions: options },
			),
		).toEqual({
			status: 'loading',
			title: 'New report',
			subjectLabel: 'Notes',
			href: '/acme/reports/r2',
		})
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r2' },
				{ orgSlug: 'acme', reports: reportData(), savedReportOptions: options },
			),
		).toMatchObject({ status: 'loading', title: 'New report' })
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r3' },
				{ orgSlug: 'acme', reports: null, savedReportOptions: options },
			),
		).toEqual({
			status: 'loading',
			title: null,
			subjectLabel: null,
			href: '/acme/reports/r3',
		})
	})

	it('reports a deleted saved report as not found', () => {
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r1' },
				{ orgSlug: 'acme', reports: reportData({ r1: null }) },
			),
		).toEqual({
			status: 'not-found',
			title: null,
			subjectLabel: null,
			href: null,
		})
	})

	it('flags a saved report whose definition cannot be read, without a link', () => {
		expect(
			resolveReportBlock(
				{ source: 'saved', reportId: 'r1' },
				{
					orgSlug: 'acme',
					reports: reportData({ r1: { title: 'Broken', definition: null } }),
				},
			),
		).toEqual({
			status: 'unreadable',
			title: 'Broken',
			subjectLabel: null,
			href: null,
		})
	})
})

describe('isReportAccessDenied', () => {
	it('is false without an error', () => {
		expect(isReportAccessDenied(null)).toBe(false)
	})

	it('treats refused tokens and unauthorized responses as no access', () => {
		expect(
			isReportAccessDenied({
				error: 'unauthorized',
				message: 'Could not authorize regional analytics.',
			}),
		).toBe(true)
		expect(
			isReportAccessDenied({
				error: 'unauthorized',
				message: 'Invalid operator token',
			}),
		).toBe(true)
	})

	it('treats a subject the token does not cover as no access', () => {
		expect(
			isReportAccessDenied({
				error: 'forbidden_subject' as never,
				message: 'You do not have permission to report on this data.',
			}),
		).toBe(true)
	})

	it('keeps every other failure an error', () => {
		for (const error of [
			'Failed to run report.',
			'Could not authorize regional analytics.',
			'Failed to fetch',
			{ error: 'invalid_definition' as const, message: 'Bad report' },
			{
				error: 'tenant_not_provisioned' as const,
				message: 'This organization has not provisioned a customer database.',
			},
			{
				error: 'shop_not_available' as never,
				message: 'Shop order reports are only available for US organizations.',
			},
		]) {
			expect(isReportAccessDenied(error)).toBe(false)
		}
	})
})
