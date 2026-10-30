import { getBrowserTenantApiUrl, getOrgBinding } from '~/lib/client-auth'

/**
 * Whether this site runs a rewards program, from the anonymous
 * `GET /loyalty/program` the browser sends to the region. It only decides
 * whether links to the rewards page show, so it skips schema parsing (and
 * the loyalty client) to keep account pages light; any failure hides them.
 */
export async function loyaltyProgramAvailable(
	deps: {
		fetchImpl?: typeof fetch
		baseUrl?: () => string
		binding?: () => { slug?: string; host?: string }
	} = {},
): Promise<boolean> {
	const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(
		(deps.binding ?? getOrgBinding)(),
	)) {
		if (value) search.set(key, value)
	}
	const query = search.toString()
	try {
		const base = (deps.baseUrl ?? getBrowserTenantApiUrl)().replace(/\/$/, '')
		const res = await fetchImpl(
			`${base}/loyalty/program${query ? `?${query}` : ''}`,
			{ headers: { 'X-Client': 'web' }, cache: 'no-store' },
		)
		if (!res.ok) return false
		const data: unknown = await res.json()
		const program =
			data && typeof data === 'object'
				? (data as { program?: unknown }).program
				: null
		return Boolean(program && typeof program === 'object')
	} catch {
		return false
	}
}

/** Shows every hidden `[data-loyalty-link]` once the program is known to exist. */
export async function revealLoyaltyLinks(
	root: ParentNode = document,
	isAvailable: () => Promise<boolean> = loyaltyProgramAvailable,
): Promise<void> {
	const hidden = Array.from(
		root.querySelectorAll<HTMLElement>('[data-loyalty-link]'),
	).filter((node) => node.hidden)
	if (hidden.length === 0) return
	if (!(await isAvailable())) return
	for (const node of hidden) node.hidden = false
}
