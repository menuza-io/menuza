import { vi, type Mock } from 'vitest'
import { fixtures } from '../../utils/fixtures'

type MockResponse = {
	ok: boolean
	statusText?: string
	json?: () => Promise<unknown>
	text?: () => Promise<string>
}

function jsonResponse(data: unknown): MockResponse {
	return {
		ok: true,
		json: async () => data,
	}
}

function errorResponse(statusText: string): MockResponse {
	return { ok: false, statusText }
}

export function jiraApiRequestOptions(token = 'decrypted-access-token') {
	return {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
		redirect: 'manual',
	}
}

export function mockJiraFetch(
	overrides: {
		token?: MockResponse
		user?: MockResponse | 'error'
		resources?: MockResponse | 'error'
		routes?: Record<string, MockResponse | 'error'>
	} = {},
): Mock {
	return vi.fn(async (url: string) => {
		const urlStr = url.toString()

		if (urlStr === 'https://auth.atlassian.com/oauth/token') {
			return (
				overrides.token ?? {
					ok: true,
					json: async () => fixtures.jira.oauthResponse,
					text: async () => '',
				}
			)
		}

		if (urlStr === 'https://api.atlassian.com/me') {
			if (overrides.user === 'error') {
				return errorResponse('Unauthorized')
			}
			return overrides.user ?? jsonResponse(fixtures.jira.currentUserResponse)
		}

		if (
			urlStr === 'https://api.atlassian.com/oauth/token/accessible-resources'
		) {
			if (overrides.resources === 'error') {
				return errorResponse('Forbidden')
			}
			return (
				overrides.resources ??
				jsonResponse(fixtures.jira.accessibleResourcesResponse)
			)
		}

		if (overrides.routes) {
			for (const [pattern, handler] of Object.entries(overrides.routes)) {
				if (urlStr.includes(pattern)) {
					if (handler === 'error') {
						return errorResponse('error')
					}
					return handler
				}
			}
		}

		throw new Error(`Unexpected fetch URL: ${urlStr}`)
	})
}
