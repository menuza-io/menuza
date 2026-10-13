import { and, db, eq, inArray, SavedReport } from '@repo/database'
import { organizationTemplates } from '@repo/reports'
import { data } from 'react-router'
import { z } from 'zod'
import {
	parseDashboardConfig,
	type DashboardConfig,
	type DashboardConfigErrorCode,
	type ReportBlockConfig,
} from './config.ts'
import { getHomeConfig, resetHome, saveHomeConfig } from './queries.server.ts'

export type DashboardActionErrorCode =
	| DashboardConfigErrorCode
	| 'invalid-request'
	| 'unknown-template'
	| 'unknown-report'

export type DashboardActionError = {
	code: DashboardActionErrorCode
	message: string
}

type SubmittedConfigResult =
	| { success: true; config: DashboardConfig }
	| { success: false; error: DashboardActionError }

export function dashboardActionError(
	code: DashboardActionErrorCode,
	message: string,
) {
	return data({ ok: false as const, error: { code, message } }, { status: 400 })
}

function invalidRequest() {
	return dashboardActionError('invalid-request', 'The request is invalid.')
}

/** The fields of a form POST, or null when the body is not form data. */
export async function readFormFields(request: Request) {
	try {
		return Object.fromEntries(await request.formData())
	} catch {
		return null
	}
}

function reportReferenceKey(config: ReportBlockConfig) {
	return config.source === 'saved'
		? `saved:${config.reportId}`
		: `template:${config.templateId}`
}

function reportReferences(config: DashboardConfig) {
	return config.blocks.flatMap((block) =>
		block.type === 'report' ? [block.config] : [],
	)
}

/**
 * Checks that report blocks point at an organization template or a saved
 * report of this organization. References the dashboard already had are
 * accepted as they are, so a report deleted later does not block every
 * further layout change.
 */
async function checkReportReferences({
	config,
	previous,
	organizationId,
}: {
	config: DashboardConfig
	previous: DashboardConfig
	organizationId: string
}): Promise<DashboardActionError | null> {
	const known = new Set(reportReferences(previous).map(reportReferenceKey))
	const added = reportReferences(config).filter(
		(reference) => !known.has(reportReferenceKey(reference)),
	)
	const templateIds = new Set<string>()
	const reportIds = new Set<string>()
	for (const reference of added) {
		if (reference.source === 'template') templateIds.add(reference.templateId)
		else reportIds.add(reference.reportId)
	}

	if (templateIds.size > 0) {
		const templates = new Set(
			organizationTemplates().map((template) => template.id),
		)
		if ([...templateIds].some((id) => !templates.has(id))) {
			return {
				code: 'unknown-template',
				message: 'A report block uses a report template that does not exist.',
			}
		}
	}

	if (reportIds.size > 0) {
		const found = await db
			.select({ id: SavedReport.id })
			.from(SavedReport)
			.where(
				and(
					eq(SavedReport.organizationId, organizationId),
					inArray(SavedReport.id, [...reportIds]),
				),
			)
		if (found.length < reportIds.size) {
			return {
				code: 'unknown-report',
				message:
					'A report block uses a saved report that is not in this organization.',
			}
		}
	}
	return null
}

/**
 * Parses and normalizes a submitted dashboard config and checks the reports
 * it references.
 */
export async function parseSubmittedConfig({
	raw,
	previous,
	organizationId,
}: {
	raw: string
	previous: DashboardConfig
	organizationId: string
}): Promise<SubmittedConfigResult> {
	const result = parseDashboardConfig(raw)
	if (!result.success) return result
	const error = await checkReportReferences({
		config: result.config,
		previous,
		organizationId,
	})
	return error ? { success: false, error } : result
}

const homeIntentSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('save-config'), config: z.string() }),
	z.object({ intent: z.literal('reset') }),
])

/**
 * Home intents. Home always belongs to the signed-in user, so being an active
 * member of the organization is the only access check.
 */
export async function handleHomeAction({
	request,
	userId,
	organizationId,
}: {
	request: Request
	userId: string
	organizationId: string
}) {
	const fields = await readFormFields(request)
	const submission = homeIntentSchema.safeParse(fields)
	if (!submission.success) return invalidRequest()

	switch (submission.data.intent) {
		case 'save-config': {
			const result = await parseSubmittedConfig({
				raw: submission.data.config,
				previous: await getHomeConfig(userId, organizationId),
				organizationId,
			})
			if (!result.success) {
				return dashboardActionError(result.error.code, result.error.message)
			}
			await saveHomeConfig({ userId, organizationId, config: result.config })
			return { ok: true as const }
		}
		case 'reset': {
			await resetHome({ userId, organizationId })
			return { ok: true as const }
		}
	}
}
