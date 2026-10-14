import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { parseScreenerQuestions } from '@repo/common/job-posting'
import type { ScreenerQuestion } from '@repo/common/job-posting'
import {
	internalJobPostingSchema,
	STAFFING_JOB_POSTING_PATH,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * A live job posting, as the control plane knows it. tenant-api cannot read the
 * control plane, and the applicant's browser must not be trusted to say what a
 * posting asks, so the apply route pulls the posting from an App resource route
 * guarded by `INTERNAL_COMMAND_TOKEN` (the same pattern as the scope
 * context). Only public content crosses, plus which answers are dealbreakers,
 * which stays server side. No person data goes the other way: the request
 * names an organization and a posting slug.
 *
 * The App answers 404 for a posting that is not live, for an organization whose
 * `staffing.hiring` flag is off, and for an unknown organization, and this
 * module reports all three as "not found". An unreachable App is a different
 * answer ("unavailable"): the apply route tells the applicant to try again
 * rather than accept an application it cannot validate.
 */

export type LivePosting = {
	id: string
	slug: string
	title: string
	positionName: string
	/** The scopes an applicant may choose from (empty: the business has none). */
	scopeIds: string[]
	questions: ScreenerQuestion[]
}

export type PostingLookup =
	| { status: 'found'; posting: LivePosting }
	| { status: 'not_found' }
	| { status: 'unavailable' }

const FOUND_TTL_MS = 60 * 1000
const MISSING_TTL_MS = 15 * 1000

type Entry = { at: number; posting: LivePosting | null }
const cache = new LRUCache<string, Entry>({ max: 500, ttl: FOUND_TTL_MS })

export function resetJobPostingCache() {
	cache.clear()
}

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function getLivePosting(
	orgId: string,
	slug: string,
	now = Date.now(),
): Promise<PostingLookup> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return { status: 'not_found' }
	const key = `${orgId}|${slug}`
	const cached = cache.get(key)
	if (cached) {
		const fresh =
			now - cached.at < (cached.posting ? FOUND_TTL_MS : MISSING_TTL_MS)
		if (fresh) {
			return cached.posting
				? { status: 'found', posting: cached.posting }
				: { status: 'not_found' }
		}
	}

	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return { status: 'unavailable' }

	try {
		const response = await fetch(
			`${base}${STAFFING_JOB_POSTING_PATH}?${new URLSearchParams({ orgId, slug })}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(4_000),
			},
		)
		if (response.status === 404) {
			cache.set(key, { at: now, posting: null })
			return { status: 'not_found' }
		}
		if (!response.ok) return { status: 'unavailable' }
		const parsed = internalJobPostingSchema.safeParse(await response.json())
		if (
			!parsed.success ||
			parsed.data.orgId !== orgId ||
			parsed.data.posting.slug !== slug
		) {
			return { status: 'unavailable' }
		}
		const { posting } = parsed.data
		const live: LivePosting = {
			id: posting.id,
			slug: posting.slug,
			title: posting.title,
			positionName: posting.positionName,
			scopeIds: posting.scopeIds,
			questions: parseScreenerQuestions(posting.questions),
		}
		cache.set(key, { at: now, posting: live })
		return { status: 'found', posting: live }
	} catch {
		return { status: 'unavailable' }
	}
}
