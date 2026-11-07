import { and, ConfigFlag, db, desc, eq } from '@repo/database'

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
		// The unique index (key, level, organization id, user id; a NULL id
		// counts as empty, migration 0027) allows one row per scope, but this
		// query does not filter every id column (a user flag matches any
		// organization id), so it can still match several rows. Pick the most
		// recently changed one deterministically instead of whatever row SQLite
		// returns first.
		.orderBy(desc(ConfigFlag.updatedAt), desc(ConfigFlag.id))
		.limit(1)
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
