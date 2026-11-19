/**
 * Redirect rules shared by Website, Redirects and the automatic redirects
 * added when a published page's URL changes or the page is deleted (#88).
 * Pure: `redirects.server.ts` reads the rows and writes the plan.
 */

/** Hops followed before a chain is called a loop (as Website, Redirects). */
export const MAX_REDIRECT_HOPS = 25

export type RedirectSource =
	'manual' | 'page_rename' | 'page_delete' | 'location_rename'

export type RedirectRow = {
	id: string
	fromPath: string
	toPath: string
	source?: string | null
}

export function isExternalDestination(path: string): boolean {
	return path.startsWith('http://') || path.startsWith('https://')
}

/**
 * Leading slash, no trailing slash (except `/`). External URLs are kept as
 * typed. Same rules as the Redirects screen always used.
 */
export function normalizeRedirectPath(value: string): string {
	let clean = value.trim()
	if (!clean.startsWith('/') && !isExternalDestination(clean)) {
		clean = `/${clean}`
	}
	if (
		clean.length > 1 &&
		clean.endsWith('/') &&
		!isExternalDestination(clean)
	) {
		clean = clean.slice(0, -1)
	}
	return clean
}

/** The root-relative path of a website page (`/` for the home page). */
export function websitePagePath(page: {
	slug: string
	isHomePage?: boolean
}): string {
	const slug = page.slug.replace(/^\/+|\/+$/g, '')
	if (page.isHomePage || slug === '' || slug === 'home') return '/'
	return `/${slug}`
}

const key = (path: string) => path.toLowerCase()

/**
 * Whether adding `fromPath -> toPath` (replacing `ignoreId`) makes a loop or
 * points a path at itself. Follows internal hops up to 25.
 */
export function hasRedirectCycle(
	rows: readonly RedirectRow[],
	fromPath: string,
	toPath: string,
	ignoreId?: string,
): boolean {
	if (key(fromPath) === key(toPath)) return true
	if (isExternalDestination(toPath)) return false
	const map = new Map<string, string>()
	for (const row of rows) {
		if (ignoreId && row.id === ignoreId) continue
		map.set(key(row.fromPath), row.toPath)
	}
	map.set(key(fromPath), toPath)
	let current: string | undefined = key(toPath)
	const visited = new Set([key(fromPath)])
	let hops = 0
	while (current && map.has(current) && hops < MAX_REDIRECT_HOPS) {
		hops++
		const next = map.get(current)
		if (!next || isExternalDestination(next)) break
		const nextKey = key(next)
		if (visited.has(nextKey)) return true
		visited.add(nextKey)
		current = nextKey
	}
	return false
}

export type AutomaticRedirectPlan = {
	/** Redirects removed because they would hide the page's new address. */
	deleteIds: string[]
	/** Redirects pointed straight at the new destination (chains collapsed). */
	updates: Array<{ id: string; toPath: string }>
	/** The redirect added, or null (a redirect from the old path already exists). */
	insert: { fromPath: string; toPath: string; source: RedirectSource } | null
	/** Why nothing was added, when nothing was. */
	skipped?: 'manual_redirect_exists' | 'same_path' | 'redirect_loop'
}

/**
 * What to change when a page moves from `oldPath` to `newPath` (rename) or
 * goes away with its visitors sent to `newPath` (delete):
 *
 * - a redirect from the new path would hide the page, so it is removed
 *   (renaming back to an earlier URL);
 * - every internal redirect that pointed at the old path now points straight
 *   at the new one, so visitors never take two hops;
 * - a redirect from the old path to the new one is added, unless one from
 *   the old path already exists: the operator's rule wins and is kept.
 */
export function planAutomaticRedirect(input: {
	existing: readonly RedirectRow[]
	oldPath: string
	newPath: string
	source: Exclude<RedirectSource, 'manual'>
	/** On delete the destination is another page: never remove its redirects. */
	removeConflicts?: boolean
}): AutomaticRedirectPlan {
	const oldPath = normalizeRedirectPath(input.oldPath)
	const newPath = normalizeRedirectPath(input.newPath)
	const plan: AutomaticRedirectPlan = {
		deleteIds: [],
		updates: [],
		insert: null,
	}
	if (key(oldPath) === key(newPath) || oldPath === '/') {
		plan.skipped = 'same_path'
		return plan
	}
	const removeConflicts =
		input.removeConflicts ?? input.source !== 'page_delete'
	const remaining: RedirectRow[] = []
	for (const row of input.existing) {
		if (
			removeConflicts &&
			key(normalizeRedirectPath(row.fromPath)) === key(newPath)
		) {
			plan.deleteIds.push(row.id)
			continue
		}
		remaining.push(row)
	}

	let fromOld: RedirectRow | undefined
	const after: RedirectRow[] = []
	for (const row of remaining) {
		const from = normalizeRedirectPath(row.fromPath)
		const to = isExternalDestination(row.toPath)
			? row.toPath
			: normalizeRedirectPath(row.toPath)
		if (key(from) === key(oldPath)) {
			fromOld = row
			after.push(row)
			continue
		}
		if (!isExternalDestination(to) && key(to) === key(oldPath)) {
			// A redirect from the destination back to the old path stays as it is,
			// so the loop check below refuses the plan.
			if (key(from) === key(newPath)) {
				after.push(row)
				continue
			}
			plan.updates.push({ id: row.id, toPath: newPath })
			after.push({ ...row, toPath: newPath })
			continue
		}
		after.push(row)
	}

	if (fromOld) {
		plan.skipped = 'manual_redirect_exists'
		return plan
	}
	if (hasRedirectCycle(after, oldPath, newPath)) {
		return {
			deleteIds: [],
			updates: [],
			insert: null,
			skipped: 'redirect_loop',
		}
	}
	plan.insert = { fromPath: oldPath, toPath: newPath, source: input.source }
	return plan
}
