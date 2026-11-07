import { auditService, AuditAction } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { and, ConfigFlag, db, eq, isNull, ne } from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { FeatureFlags } from '#app/components/admin/feature-flags.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
	// Layout loaders do not run for direct action requests; guard here too.
	await requireUserWithRole(request, 'admin')
	const flags = (await db.select().from(ConfigFlag)).map((flag) => ({
		...flag,
		value: flag.value as any,
		level: flag.level as 'system' | 'organization' | 'user',
	}))
	return { flags }
}

const createUpdateSchema = z
	.object({
		key: z.string(),
		value: z.string(),
		level: z.enum(['system', 'organization', 'user']),
		organizationId: z.string().optional(),
		userId: z.string().optional(),
		type: z.string(),
		id: z.string().optional(),
	})
	.refine(
		(data) => {
			if (data.level === 'organization') {
				return !!data.organizationId
			}
			return true
		},
		{
			message: 'Organization ID is required for organization level flags',
			path: ['organizationId'],
		},
	)
	.refine(
		(data) => {
			if (data.level === 'user') {
				return !!data.userId
			}
			return true
		},
		{
			message: 'User ID is required for user level flags',
			path: ['userId'],
		},
	)

const deleteSchema = z.object({
	id: z.string().min(1, 'ID is required for delete'),
})

type FlagScope = {
	key: string
	level: string
	organizationId: string | null
	userId: string | null
}

/** The row with the same key, level, organization and user (NULLs matched). */
function sameScope(scope: FlagScope) {
	return and(
		eq(ConfigFlag.key, scope.key),
		eq(ConfigFlag.level, scope.level),
		scope.organizationId
			? eq(ConfigFlag.organizationId, scope.organizationId)
			: isNull(ConfigFlag.organizationId),
		scope.userId
			? eq(ConfigFlag.userId, scope.userId)
			: isNull(ConfigFlag.userId),
	)
}

/**
 * Creates the flag, or updates it when it already exists. A unique index over
 * the key, level and scope (NULLs included) keeps one row, so concurrent
 * creates cannot add a second: the insert that loses does nothing and the
 * update gives the one row its value.
 */
async function upsertFlag(scope: FlagScope, value: unknown) {
	const [inserted] = await db
		.insert(ConfigFlag)
		.values({ ...scope, value })
		.onConflictDoNothing()
		.returning({ id: ConfigFlag.id })
	if (inserted) return { id: inserted.id, created: true }
	const [updated] = await db
		.update(ConfigFlag)
		.set({ value })
		.where(sameScope(scope))
		.returning({ id: ConfigFlag.id })
	if (!updated) throw new Error('Feature flag was not saved')
	return { id: updated.id, created: false }
}

/**
 * Flag changes switch features for organizations and users, so each one is
 * audited here. `auditSensitiveRoutes` in `entry.server.tsx` only sees
 * document requests, not these fetcher posts.
 */
async function auditFlagChange(
	request: Request,
	adminUserId: string,
	details: string,
	metadata: Record<string, unknown>,
) {
	await auditService.logAdminOperation(
		AuditAction.ADMIN_CONFIG_CHANGED,
		adminUserId,
		details,
		{ resource: 'feature_flag', ...metadata },
		request,
	)
}

export async function action({ request }: ActionFunctionArgs) {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const formData = await request.formData()
	const _action = formData.get('_action')

	if (_action === 'delete') {
		const result = deleteSchema.safeParse({ id: formData.get('id') })
		if (!result.success) {
			return Response.json(
				{ errors: z.flattenError(result.error).fieldErrors },
				{ status: 400 },
			)
		}
		const deleted = await db
			.delete(ConfigFlag)
			.where(eq(ConfigFlag.id, result.data.id))
			.returning({
				id: ConfigFlag.id,
				key: ConfigFlag.key,
				level: ConfigFlag.level,
				organizationId: ConfigFlag.organizationId,
				userId: ConfigFlag.userId,
			})
		for (const flag of deleted) {
			await auditFlagChange(
				request,
				adminUserId,
				`Deleted feature flag ${flag.key}`,
				{ action: 'delete', flagId: flag.id, ...flag },
			)
		}
		return Response.json({ ok: true })
	}

	const values = Object.fromEntries(formData)
	const result = createUpdateSchema.safeParse(values)
	if (!result.success) {
		return Response.json(
			{ errors: z.flattenError(result.error).fieldErrors },
			{ status: 400 },
		)
	}

	let value: any
	switch (result.data.type) {
		case 'number':
			value = Number(result.data.value)
			break
		case 'boolean':
			value = result.data.value === 'on'
			break
		case 'date':
			value = new Date(result.data.value as string)
			break
		default:
			value = result.data.value as string
	}

	try {
		const scope: FlagScope = {
			key: result.data.key,
			level: result.data.level,
			organizationId: result.data.organizationId || null,
			userId: result.data.userId || null,
		}

		if (_action === 'create') {
			const saved = await upsertFlag(scope, value)
			await auditFlagChange(
				request,
				adminUserId,
				`${saved.created ? 'Created' : 'Updated'} feature flag ${scope.key}`,
				{ action: 'create', flagId: saved.id, ...scope, value },
			)
		}

		if (_action === 'update') {
			if (!result.data.id) {
				return Response.json(
					{ errors: { id: ['ID is required for update'] } },
					{ status: 400 },
				)
			}
			// Moving a flag onto another row's key and scope would leave two rows
			// that `getFeatureFlag` cannot tell apart.
			const [clash] = await db
				.select({ id: ConfigFlag.id })
				.from(ConfigFlag)
				.where(and(sameScope(scope), ne(ConfigFlag.id, result.data.id)))
				.limit(1)
			if (clash) {
				return Response.json(
					{ error: 'A flag with this key already exists at this level' },
					{ status: 400 },
				)
			}
			await db
				.update(ConfigFlag)
				.set({ ...scope, value })
				.where(eq(ConfigFlag.id, result.data.id))
			await auditFlagChange(
				request,
				adminUserId,
				`Updated feature flag ${scope.key}`,
				{ action: 'update', flagId: result.data.id, ...scope, value },
			)
		}

		return Response.json({ ok: true })
	} catch (error: any) {
		// An update that moved a flag onto another row's key and scope.
		if (
			String(error?.message ?? '').includes('UNIQUE constraint failed') ||
			String(error?.cause?.message ?? '').includes('UNIQUE constraint failed')
		) {
			return Response.json(
				{ error: 'A flag with this key already exists at this level' },
				{ status: 400 },
			)
		}
		throw error
	}
}

export default function FeatureFlagsAdmin() {
	return <FeatureFlags />
}
