import { getLocalDomain } from '@repo/config/brand'

export function resolvePosUrl(
	posUrl: string | undefined,
	nodeEnv: string | undefined,
): string {
	return (
		posUrl ||
		(nodeEnv === 'development' ? `https://pos.${getLocalDomain()}:2999` : '')
	)
}
