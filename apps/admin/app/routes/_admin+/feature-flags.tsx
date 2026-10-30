import { and, ConfigFlag, db, eq, isNull } from '@repo/database'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { FeatureFlags } from '#app/components/admin/feature-flags.tsx'

export async function loader({ request: _request }: LoaderFunctionArgs) {
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

export async function action({ request }: ActionFunctionArgs) {
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
		await db.delete(ConfigFlag).where(eq(ConfigFlag.id, result.data.id))
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
		if (_action === 'create') {
			const [existing] = await db
				.select()
				.from(ConfigFlag)
				.where(
					and(
						eq(ConfigFlag.key, result.data.key),
						eq(ConfigFlag.level, result.data.level),
						result.data.organizationId
							? eq(ConfigFlag.organizationId, result.data.organizationId)
							: isNull(ConfigFlag.organizationId),
						result.data.userId
							? eq(ConfigFlag.userId, result.data.userId)
							: isNull(ConfigFlag.userId),
					),
				)
				.limit(1)
			if (existing) {
				return Response.json(
					{ error: 'A flag with this key already exists at this level' },
					{ status: 400 },
				)
			}
			await db.insert(ConfigFlag).values({
				key: result.data.key,
				value: value,
				level: result.data.level,
				organizationId: result.data.organizationId || null,
				userId: result.data.userId || null,
			})
		}

		if (_action === 'update') {
			if (!result.data.id) {
				return Response.json(
					{ errors: { id: ['ID is required for update'] } },
					{ status: 400 },
				)
			}
			await db
				.update(ConfigFlag)
				.set({
					key: result.data.key,
					value: value,
					level: result.data.level,
					organizationId: result.data.organizationId || null,
					userId: result.data.userId || null,
				})
				.where(eq(ConfigFlag.id, result.data.id))
		}

		return Response.json({ ok: true })
	} catch (error: any) {
		if (error?.code === 'P2002') {
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
