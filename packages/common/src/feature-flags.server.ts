import { and, ConfigFlag, db, eq, inArray, or } from '@repo/database'

async function getFlag(
	key: string,
	level: 'system' | 'organization' | 'user',
	organizationId?: string,
	userId?: string,
) {
	const conditions = [
		eq(ConfigFlag.key, key),
		eq(ConfigFlag.level, level),
		level === 'organization'
			? eq(ConfigFlag.organizationId, organizationId!)
			: undefined,
		level === 'user' ? eq(ConfigFlag.userId, userId!) : undefined,
	].filter(Boolean)
	const [flag] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(and(...conditions))
	if (!flag) return null

	return flag.value
}

export async function getFeatureFlag(
	key: string,
	{ organizationId, userId }: { organizationId?: string; userId?: string },
) {
	if (userId) {
		const userFlag = await getFlag(key, 'user', organizationId, userId)
		if (userFlag !== null) return userFlag
	}

	if (organizationId) {
		const orgFlag = await getFlag(key, 'organization', organizationId)
		if (orgFlag !== null) return orgFlag
	}

	const systemFlag = await getFlag(key, 'system')
	return systemFlag
}

/**
 * Batch form of `getFeatureFlag` with the same precedence (user, then
 * organization, then system) in a single query. Missing keys are `null`.
 */
export async function getFeatureFlags<const Key extends string>(
	keys: readonly Key[],
	{ organizationId, userId }: { organizationId?: string; userId?: string },
): Promise<Record<Key, unknown>> {
	const result = Object.fromEntries(keys.map((key) => [key, null])) as Record<
		Key,
		unknown
	>
	if (keys.length === 0) return result
	const scopes = [
		eq(ConfigFlag.level, 'system'),
		organizationId
			? and(
					eq(ConfigFlag.level, 'organization'),
					eq(ConfigFlag.organizationId, organizationId),
				)
			: undefined,
		userId
			? and(eq(ConfigFlag.level, 'user'), eq(ConfigFlag.userId, userId))
			: undefined,
	].filter(Boolean)
	const rows = await db
		.select({
			key: ConfigFlag.key,
			level: ConfigFlag.level,
			value: ConfigFlag.value,
		})
		.from(ConfigFlag)
		.where(and(inArray(ConfigFlag.key, [...keys]), or(...scopes)))
	const rank = { user: 3, organization: 2, system: 1 } as Record<string, number>
	const best = new Map<string, number>()
	for (const row of rows) {
		const level = rank[row.level] ?? 0
		if (level > (best.get(row.key) ?? 0)) {
			best.set(row.key, level)
			result[row.key as Key] = row.value
		}
	}
	return result
}
