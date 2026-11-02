import { z } from 'zod'
import { createOAuthHandoff } from '#app/utils/oauth/handoff.server.ts'

/**
 * The OAuth hand-off for the note integrations (Slack, Jira, ...; see
 * `createOAuthHandoff`). `state` is the value the provider echoes to the
 * callback: its signed `state`, or Trello's request token (OAuth 1.0a).
 */

export type IntegrationOAuthState = {
	state: string
	provider: string
	userId: string
	orgSlug: string
}

const handoff = createOAuthHandoff<IntegrationOAuthState>({
	name: 'integrations_oauth',
	path: '/api/integrations/oauth',
	schema: z.object({
		state: z.string().min(1),
		provider: z.string().min(1),
		userId: z.string(),
		orgSlug: z.string(),
	}),
})

export const setIntegrationOAuthState = handoff.set
export const readIntegrationOAuthState = handoff.read
export const clearIntegrationOAuthState = handoff.clear
export { sameState } from '#app/utils/oauth/handoff.server.ts'
