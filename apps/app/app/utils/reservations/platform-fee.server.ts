import { and, ConfigFlag, db, eq, isNull } from '@repo/database'

export const PLATFORM_FEE_FLAG_KEY = 'reservations.platform_fee_bp'

/**
 * Accepts only integer basis points from 0 to 10000. A number, or a string
 * that JSON-parses to a number, is accepted; anything else is `null`.
 */
export function parsePlatformFeeBp(value: unknown): number | null {
	let candidate: unknown = value
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return null
		}
	}
	if (typeof candidate !== 'number' || !Number.isInteger(candidate)) return null
	if (candidate < 0 || candidate > 10_000) return null
	return candidate
}

function warnInvalid(level: 'organization' | 'system') {
	console.warn(
		`[reservations] ignoring invalid ${PLATFORM_FEE_FLAG_KEY} at ${level} level: not an integer from 0 to 10000`,
	)
}

/**
 * Platform fee in basis points for an organization: its own override when
 * valid, else the system default when valid, else 0.
 */
export async function resolveReservationPlatformFeeBp(
	organizationId: string,
): Promise<number> {
	const [orgRow] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, PLATFORM_FEE_FLAG_KEY),
				eq(ConfigFlag.level, 'organization'),
				eq(ConfigFlag.organizationId, organizationId),
			),
		)
		.limit(1)
	if (orgRow) {
		const parsed = parsePlatformFeeBp(orgRow.value)
		if (parsed !== null) return parsed
		warnInvalid('organization')
	}

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
	if (systemRow) {
		const parsed = parsePlatformFeeBp(systemRow.value)
		if (parsed !== null) return parsed
		warnInvalid('system')
	}
	return 0
}
