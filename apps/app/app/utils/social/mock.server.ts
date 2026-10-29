import crypto from 'node:crypto'
import { SocialError } from './errors.ts'
import { type SocialPlatform } from './platforms.ts'

/**
 * The local Meta emulator (`SOCIAL_MOCK=true`, local BASE_URL only):
 * connecting adds one sample Facebook Page or Instagram account, and
 * publishing succeeds without network access. A post whose text contains
 * `#fail` is refused, to try the failure and retry path.
 */

const ACCOUNTS: Record<
	SocialPlatform,
	{ externalId: string; name: string; username: string | null }
> = {
	facebook: { externalId: 'mock-page-1', name: 'Demo Page', username: null },
	instagram: {
		externalId: 'mock-ig-1',
		name: 'Demo Instagram',
		username: 'demo.business',
	},
}

export const mockMeta = {
	userToken: () => 'mock-user-token',
	accounts: (platform: SocialPlatform) => [
		{
			platform,
			...ACCOUNTS[platform],
			accessToken: `mock-page-token-${platform}`,
		},
	],
	publish: async (
		platform: SocialPlatform,
		input: { body: string; imageUrls: string[] },
	) => {
		if (input.body.includes('#fail')) {
			throw new SocialError('rejected', 'mock_refused')
		}
		if (platform === 'instagram' && input.imageUrls.length === 0) {
			throw new SocialError('rejected', 'needs_image')
		}
		return {
			externalPostId: `mock_${platform}_${crypto.randomBytes(6).toString('hex')}`,
			permalink: null,
		}
	},
}
