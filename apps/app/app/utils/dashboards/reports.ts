import {
	getCatalog,
	getSubject,
	organizationTemplates,
	templateCategories,
	type ReportDefinition,
	type ReportRunError,
	type ReportTemplate,
} from '@repo/reports'
import { type ReportBlockConfig } from './config.ts'

/** The catalog every organization report block runs against. */
export const ORGANIZATION_REPORT_CATALOG = getCatalog('organization')

/** A saved report offered in the Add block dialog. */
export type SavedReportOption = {
	id: string
	title: string
	subjectLabel: string
}

export type ReportTemplateOption = {
	id: string
	title: string
	description: string
	subjectLabel: string
}

export type ReportTemplateGroup = {
	category: string
	templates: ReportTemplateOption[]
}

/** A saved report shown by report blocks; `definition` is null if unreadable. */
export type SavedReportBlockData = {
	title: string
	definition: ReportDefinition | null
}

/** What report blocks need from the page data. */
export type ReportBlockData = {
	/** By report id; null when the organization no longer has the report. */
	savedReports: Record<string, SavedReportBlockData | null>
	runUrl: string
	tokenUrl: string
	tenantApiUrl: string
}

let templatesById: ReadonlyMap<string, ReportTemplate> | undefined

/** The organization template with this id, built once so it stays the same object. */
export function findOrganizationTemplate(templateId: string) {
	templatesById ??= new Map(
		organizationTemplates().map((template) => [template.id, template]),
	)
	return templatesById.get(templateId) ?? null
}

export function reportSubjectLabel(subjectId: string) {
	return getSubject(ORGANIZATION_REPORT_CATALOG, subjectId)?.label ?? subjectId
}

let templateGroups: ReportTemplateGroup[] | undefined

/** The organization templates by category, in the order the reports page uses. */
export function reportTemplateGroups(): ReportTemplateGroup[] {
	if (templateGroups) return templateGroups
	const templates = organizationTemplates()
	templateGroups = templateCategories(templates).map((category) => ({
		category,
		templates: templates
			.filter((template) => template.category === category)
			.map((template) => ({
				id: template.id,
				title: template.title,
				description: template.description,
				subjectLabel: reportSubjectLabel(template.definition.subject),
			})),
	}))
	return templateGroups
}

/** Where "Open report" goes: the saved report, or the template in the builder. */
export function reportBlockHref(orgSlug: string, config: ReportBlockConfig) {
	return config.source === 'saved'
		? `/${orgSlug}/reports/${encodeURIComponent(config.reportId)}`
		: `/${orgSlug}/reports/new?template=${encodeURIComponent(config.templateId)}`
}

export type ResolvedReportBlock =
	| {
			status: 'loading'
			title: string | null
			subjectLabel: string | null
			href: string
	  }
	| { status: 'not-found'; title: null; subjectLabel: null; href: null }
	| { status: 'unreadable'; title: string; subjectLabel: null; href: null }
	| {
			status: 'ready'
			title: string
			subjectLabel: string
			href: string
			definition: ReportDefinition
	  }

const NOT_FOUND = {
	status: 'not-found',
	title: null,
	subjectLabel: null,
	href: null,
} as const

/**
 * What a report block shows. Blocks added since the page data loaded have
 * no report data yet and wait for it, using the Add block dialog's saved
 * report titles in the meantime. A saved report that cannot be read has no
 * link, as its page cannot open it either.
 */
export function resolveReportBlock(
	config: ReportBlockConfig,
	{
		orgSlug,
		reports,
		savedReportOptions = [],
	}: {
		orgSlug: string
		reports: ReportBlockData | null
		savedReportOptions?: readonly SavedReportOption[]
	},
): ResolvedReportBlock {
	const href = reportBlockHref(orgSlug, config)
	if (config.source === 'template') {
		const template = findOrganizationTemplate(config.templateId)
		if (!template) return NOT_FOUND
		const subjectLabel = reportSubjectLabel(template.definition.subject)
		if (!reports) {
			return { status: 'loading', title: template.title, subjectLabel, href }
		}
		return {
			status: 'ready',
			title: template.title,
			subjectLabel,
			href,
			definition: template.definition,
		}
	}

	const saved = reports?.savedReports[config.reportId]
	if (saved === null) return NOT_FOUND
	if (!saved) {
		const option = savedReportOptions.find(
			(item) => item.id === config.reportId,
		)
		return {
			status: 'loading',
			title: option?.title ?? null,
			subjectLabel: option?.subjectLabel ?? null,
			href,
		}
	}
	if (!saved.definition) {
		return {
			status: 'unreadable',
			title: saved.title,
			subjectLabel: null,
			href: null,
		}
	}
	return {
		status: 'ready',
		title: saved.title,
		subjectLabel: reportSubjectLabel(saved.definition.subject),
		href,
		definition: saved.definition,
	}
}

const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set([
	'unauthorized',
	'forbidden_subject',
])

/**
 * Whether a report failed because the viewer may not read its data: the
 * regional analytics token was refused, or the tenant-api or run route
 * turned the query down. Only the responses decide, as permissions can
 * change while the page stays open.
 */
export function isReportAccessDenied(error: ReportRunError | string | null) {
	return (
		typeof error === 'object' &&
		error !== null &&
		ACCESS_DENIED_CODES.has(error.error)
	)
}
