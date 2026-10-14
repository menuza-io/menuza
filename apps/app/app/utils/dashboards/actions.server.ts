import { and, db, eq, inArray, SavedReport } from '@repo/database'
import { organizationTemplates } from '@repo/reports'
import { data, redirect } from 'react-router'
import { z } from 'zod'
import { requireCustomDashboardAccess } from './access.server.ts'
import {
	canEdit,
	dashboardShareAccessSchema,
	isOwner,
	MAX_CUSTOM_DASHBOARDS,
	parseDashboardConfig,
	validateDashboardName,
	type DashboardConfig,
	type DashboardConfigErrorCode,
	type DashboardNameErrorCode,
	type ReportBlockConfig,
} from './config.ts'
import {
	createDashboard,
	deleteDashboard,
	getHomeConfig,
	isShareableMember,
	removeShare,
	renameDashboard,
	resetHome,
	saveDashboardConfig,
	saveHomeConfig,
	upsertShare,
} from './queries.server.ts'

export type DashboardActionErrorCode =
	| DashboardConfigErrorCode
	| DashboardNameErrorCode
	| 'invalid-request'
	| 'unknown-template'
	| 'unknown-report'
	| 'limit-reached'
	| 'invalid-share-target'
	| 'invalid-access'
	| 'forbidden'

export type DashboardActionError = {
	code: DashboardActionErrorCode
	message: string
}

/** What dashboard actions answer with when they do not redirect. */
export type DashboardActionResult =
	{ ok: true } | { ok: false; error: DashboardActionError }

type SubmittedConfigResult =
	| { success: true; config: DashboardConfig }
	| { success: false; error: DashboardActionError }

type ActionOrganization = { id: string; slug: string }

export function dashboardActionError(
	code: DashboardActionErrorCode,
	message: string,
	status = 400,
) {
	return data({ ok: false as const, error: { code, message } }, { status })
}

function invalidRequest() {
	return dashboardActionError('invalid-request', 'The request is invalid.')
}

/** The user can open the dashboard but may not do this to it. */
function forbidden(message: string) {
	return dashboardActionError('forbidden', message, 403)
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

/** Creates an empty custom dashboard for the user and opens it. */
async function createNamedDashboard({
	name,
	userId,
	organization,
}: {
	name: unknown
	userId: string
	organization: ActionOrganization
}) {
	const validName = validateDashboardName(name)
	if (!validName.success) {
		return dashboardActionError(validName.code, validName.message)
	}
	const result = await createDashboard({
		userId,
		organizationId: organization.id,
		name: validName.name,
	})
	if (!result.ok) {
		return dashboardActionError(
			'limit-reached',
			`You can have at most ${MAX_CUSTOM_DASHBOARDS} dashboards in an organization.`,
		)
	}
	return redirect(`/${organization.slug}/dashboards/${result.dashboard.id}`)
}

const createIntentSchema = z.object({
	// Creating is all the dashboards collection does, so the intent may be left out.
	intent: z.literal('create').default('create'),
	name: z.unknown().optional(),
})

/** POSTs to the collection of custom dashboards, which create one. */
export async function handleCreateDashboardAction({
	request,
	userId,
	organization,
}: {
	request: Request
	userId: string
	organization: ActionOrganization
}) {
	const submission = createIntentSchema.safeParse(await readFormFields(request))
	if (!submission.success) return invalidRequest()
	return createNamedDashboard({
		name: submission.data.name,
		userId,
		organization,
	})
}

const homeIntentSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('save-config'), config: z.string() }),
	z.object({ intent: z.literal('reset') }),
	z.object({ intent: z.literal('create'), name: z.unknown().optional() }),
	z.object({ intent: z.enum(['rename', 'delete', 'share', 'unshare']) }),
])

/**
 * Home intents. Home always belongs to the signed-in user, so being an active
 * member of the organization is the only access check. Home itself cannot be
 * renamed, deleted or shared.
 */
export async function handleHomeAction({
	request,
	userId,
	organization,
}: {
	request: Request
	userId: string
	organization: ActionOrganization
}) {
	const organizationId = organization.id
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
		case 'create':
			return createNamedDashboard({
				name: submission.data.name,
				userId,
				organization,
			})
		case 'rename':
		case 'delete':
		case 'share':
		case 'unshare':
			return forbidden('Home cannot be renamed, deleted or shared.')
	}
}

const shareTargetSchema = z.string().min(1)

// Share fields are checked after the owner check, so that recipients get a
// 403 for any share or unshare they send.
const customIntentSchema = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('save-config'), config: z.string() }),
	z.object({ intent: z.literal('rename'), name: z.unknown().optional() }),
	z.object({ intent: z.literal('delete') }),
	z.object({
		intent: z.literal('share'),
		userId: z.unknown().optional(),
		access: z.unknown().optional(),
	}),
	z.object({ intent: z.literal('unshare'), userId: z.unknown().optional() }),
])

function notFound() {
	return new Response('Not Found', { status: 404 })
}

/**
 * Gives an active member of the organization, other than the owner, view or
 * edit access. Sharing again with someone changes their access.
 */
async function shareDashboard({
	dashboard,
	userId,
	access,
}: {
	dashboard: { id: string; organizationId: string; ownerId: string }
	userId: unknown
	access: unknown
}) {
	const validAccess = dashboardShareAccessSchema.safeParse(access)
	if (!validAccess.success) {
		return dashboardActionError(
			'invalid-access',
			'Access must be "view" or "edit".',
		)
	}
	const target = shareTargetSchema.safeParse(userId)
	if (
		!target.success ||
		!(await isShareableMember({
			organizationId: dashboard.organizationId,
			ownerId: dashboard.ownerId,
			userId: target.data,
		}))
	) {
		return dashboardActionError(
			'invalid-share-target',
			'Dashboards can only be shared with active members of this organization other than the owner.',
		)
	}
	await upsertShare({
		dashboardId: dashboard.id,
		userId: target.data,
		access: validAccess.data,
		sharedById: dashboard.ownerId,
	})
	return { ok: true as const }
}

/**
 * Intents on a custom dashboard. Whoever cannot open the dashboard gets a 404
 * before the request is looked at; whoever can but lacks the right gets a 403.
 * Custom dashboards have no reset to a default.
 */
export async function handleCustomDashboardAction({
	request,
	userId,
	organization,
	dashboardId,
}: {
	request: Request
	userId: string
	organization: ActionOrganization
	dashboardId: string
}) {
	const { access, dashboard } = await requireCustomDashboardAccess({
		userId,
		organizationId: organization.id,
		dashboardId,
	})
	const target = { dashboardId: dashboard.id, organizationId: organization.id }
	const submission = customIntentSchema.safeParse(await readFormFields(request))
	if (!submission.success) return invalidRequest()

	switch (submission.data.intent) {
		case 'save-config': {
			if (!canEdit(access)) {
				return forbidden('You can only view this dashboard.')
			}
			const result = await parseSubmittedConfig({
				raw: submission.data.config,
				previous: dashboard.config,
				organizationId: organization.id,
			})
			if (!result.success) {
				return dashboardActionError(result.error.code, result.error.message)
			}
			if (!(await saveDashboardConfig({ ...target, config: result.config }))) {
				throw notFound()
			}
			return { ok: true as const }
		}
		case 'rename': {
			if (!isOwner(access)) {
				return forbidden('Only the owner can rename this dashboard.')
			}
			const name = validateDashboardName(submission.data.name)
			if (!name.success) return dashboardActionError(name.code, name.message)
			if (
				!(await renameDashboard({
					...target,
					ownerId: userId,
					name: name.name,
				}))
			) {
				throw notFound()
			}
			return { ok: true as const }
		}
		case 'delete': {
			if (!isOwner(access)) {
				return forbidden('Only the owner can delete this dashboard.')
			}
			await deleteDashboard({ ...target, ownerId: userId })
			return redirect(`/${organization.slug}`)
		}
		case 'share': {
			if (!isOwner(access)) {
				return forbidden('Only the owner can share this dashboard.')
			}
			return shareDashboard({
				dashboard,
				userId: submission.data.userId,
				access: submission.data.access,
			})
		}
		case 'unshare': {
			if (!isOwner(access)) {
				return forbidden('Only the owner can change who has access.')
			}
			const recipient = shareTargetSchema.safeParse(submission.data.userId)
			if (!recipient.success) return invalidRequest()
			await removeShare({ dashboardId: dashboard.id, userId: recipient.data })
			return { ok: true as const }
		}
	}
}
