import { createId } from '@paralleldrive/cuid2'
import { and, db, eq, inArray, WebsiteRedirect } from '@repo/database'
import {
	type AutomaticRedirectPlan,
	hasRedirectCycle,
	type RedirectRow,
} from './redirect-plan.ts'

export {
	hasRedirectCycle,
	normalizeRedirectPath,
	planAutomaticRedirect,
	websitePagePath,
} from './redirect-plan.ts'

/** Every redirect of an organization, for cycle checks and plans. */
export async function loadRedirectRows(
	organizationId: string,
): Promise<RedirectRow[]> {
	return db
		.select({
			id: WebsiteRedirect.id,
			fromPath: WebsiteRedirect.fromPath,
			toPath: WebsiteRedirect.toPath,
			source: WebsiteRedirect.source,
		})
		.from(WebsiteRedirect)
		.where(eq(WebsiteRedirect.organizationId, organizationId))
}

/**
 * Checks if adding or updating a redirect would cause a loop (for example
 * `/a -> /b -> /a`), following internal hops up to 25.
 */
export async function detectRedirectCycle(
	organizationId: string,
	fromPath: string,
	toPath: string,
	ignoreRedirectId?: string,
): Promise<boolean> {
	return hasRedirectCycle(
		await loadRedirectRows(organizationId),
		fromPath,
		toPath,
		ignoreRedirectId,
	)
}

/**
 * The writes of an automatic redirect plan, for one `db.batch` with the page
 * change itself (D1 transactions are not atomic). Returns the statements and
 * the id of the redirect added, if any.
 */
export function automaticRedirectStatements(
	organizationId: string,
	pageId: string | null,
	plan: AutomaticRedirectPlan,
	now = new Date(),
) {
	const statements = []
	if (plan.deleteIds.length) {
		statements.push(
			db
				.delete(WebsiteRedirect)
				.where(
					and(
						eq(WebsiteRedirect.organizationId, organizationId),
						inArray(WebsiteRedirect.id, plan.deleteIds),
					),
				),
		)
	}
	for (const update of plan.updates) {
		statements.push(
			db
				.update(WebsiteRedirect)
				.set({ toPath: update.toPath, updatedAt: now })
				.where(
					and(
						eq(WebsiteRedirect.organizationId, organizationId),
						eq(WebsiteRedirect.id, update.id),
					),
				),
		)
	}
	let insertedId: string | null = null
	if (plan.insert) {
		insertedId = createId()
		statements.push(
			db.insert(WebsiteRedirect).values({
				id: insertedId,
				organizationId,
				fromPath: plan.insert.fromPath,
				toPath: plan.insert.toPath,
				statusCode: 301,
				isEnabled: true,
				hitCount: 0,
				source: plan.insert.source,
				pageId,
				createdAt: now,
				updatedAt: now,
			}),
		)
	}
	return { statements, insertedId }
}
