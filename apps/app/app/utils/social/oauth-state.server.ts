import { z } from 'zod'
import { createOAuthHandoff } from '#app/utils/oauth/handoff.server.ts'
import { SOCIAL_PLATFORMS, type SocialPlatform } from './platforms.ts'

/**
 * The OAuth hand-off to Meta and back (see `createOAuthHandoff`): the state,
 * the platform and who started it, sent only to the callback path.
 */

export type MetaOAuthState = {
	state: string
	platform: SocialPlatform
	userId: string
	orgSlug: string
}

const handoff = createOAuthHandoff<MetaOAuthState>({
	name: 'social_meta_oauth',
	path: '/resources/social/meta',
	schema: z.object({
		state: z.string(),
		platform: z.enum(SOCIAL_PLATFORMS),
		userId: z.string(),
		orgSlug: z.string(),
	}),
})

export const setMetaOAuthState = handoff.set
export const readMetaOAuthState = handoff.read
export const clearMetaOAuthState = handoff.clear
export { newOAuthState, sameState } from '#app/utils/oauth/handoff.server.ts'
