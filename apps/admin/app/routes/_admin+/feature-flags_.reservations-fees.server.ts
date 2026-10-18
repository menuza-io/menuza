import { requireUserWithRole } from '@repo/auth'
import {
	and,
	asc,
	ConfigFlag,
	db,
	eq,
	isNull,
	or,
	Organization,
	sql,
} from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	FeeActionSchema,
	PLATFORM_FEE_FLAG_KEY,
	readStoredBp,
	type FeeActionResult,
} from './feature-flags_.reservations-fees.shared.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const [systemRow] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, 'system'),
				isNull(ConfigFlag.organizationId),
			),
		)
		.limit(1)
	const overrides = await db
		.select({
			id: ConfigFlag.id,
			value: ConfigFlag.value,
			organizationId: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
		})
		.from(ConfigFlag)
		.innerJoin(Organization, eq(Organization.id, ConfigFlag.organizationId))
		.where(
			and(
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, 'organization'),
			),
		)
		.orderBy(asc(Organization.name))
	const organizations = await db
		.select({ name: Organization.name, slug: Organization.slug })
		.from(Organization)
		.orderBy(asc(Organization.name))
		.limit(500)
	return {
		systemBp: systemRow ? readStoredBp(systemRow.value) : null,
		overrides: overrides.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			bp: readStoredBp(row.value),
		})),
		organizations,
	}
}

async function upsertFlag(
	level: 'system' | 'organization',
	bp: number,
	organizationId: string | null,
) {
	const [existing] = await db
		.select({ id: ConfigFlag.id })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, level),
				organizationId
					? eq(ConfigFlag.organizationId, organizationId)
					: isNull(ConfigFlag.organizationId),
			),
		)
		.limit(1)
	if (existing) {
		await db
			.update(ConfigFlag)
			.set({ value: bp, updatedAt: new Date() })
			.where(eq(ConfigFlag.id, existing.id))
		return
	}
	await db.insert(ConfigFlag).values({
		key: PLATFORM_FEE_FLAG_KEY,
		value: bp,
		level,
		organizationId,
		userId: null,
	})
}

export async function action({
	request,
}: ActionFunctionArgs): Promise<FeeActionResult> {
	await requireUserWithRole(request, 'admin')
	const parsed = FeeActionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		const fieldErrors: Record<string, string> = {}
		for (const issue of parsed.error.issues) {
			const key = issue.path.join('.')
			if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
		}
		return { ok: false, error: 'Check the highlighted fields.', fieldErrors }
	}
	const input = parsed.data

	if (input._action === 'set-system') {
		await upsertFlag('system', input.bp, null)
		return { ok: true }
	}

	if (input._action === 'set-override') {
		const matches = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(
				or(
					eq(Organization.id, input.organization),
					eq(Organization.slug, input.organization),
					sql`lower(${Organization.name}) = lower(${input.organization})`,
				),
			)
			.limit(2)
		if (matches.length === 0) {
			return {
				ok: false,
				error: 'Organization not found.',
				fieldErrors: { organization: 'Organization not found.' },
			}
		}
		if (matches.length > 1) {
			return {
				ok: false,
				error: 'More than one organization matches. Use its slug.',
				fieldErrors: {
					organization: 'More than one organization matches. Use its slug.',
				},
			}
		}
		await upsertFlag('organization', input.bp, matches[0]!.id)
		return { ok: true }
	}

	await db
		.delete(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.id, input.id),
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, 'organization'),
			),
		)
	return { ok: true }
}
