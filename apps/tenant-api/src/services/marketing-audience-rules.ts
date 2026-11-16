import {
	audienceLocationIds,
	type AudienceDefinition,
	type AudienceRule,
} from '@repo/common/marketing-audiences'
import { customers } from '@repo/tenant-db'
import { sql, type SQL } from 'drizzle-orm'
import { countedOrdersSql, DAY_MS } from './marketing-orders.ts'

/**
 * Compiles a saved audience (`@repo/common/marketing-audiences`) to one SQL
 * condition on the `customers` table (#98). The condition is combined with the
 * consent rules of `loadBroadcastAudience`: an audience only ever narrows who
 * may be messaged, it cannot add anyone. Every value is a bound parameter; a
 * rule holds numbers and ids, so nothing a guest typed reaches the SQL.
 *
 * Membership is evaluated when asked (a send, a preview), never cached.
 */

function compare(op: 'gte' | 'lte' | 'eq', expr: SQL, value: number): SQL {
	if (op === 'gte') return sql`${expr} >= ${value}`
	if (op === 'lte') return sql`${expr} <= ${value}`
	return sql`${expr} = ${value}`
}

function locationFilter(ids: readonly string[] | undefined): SQL {
	if (!ids || ids.length === 0) return sql``
	// bounded: the schema caps `locationIds` at 50
	return sql` AND o.location_id IN (${sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	)})`
}

function windowFilter(windowDays: number | undefined, now: number): SQL {
	return windowDays === undefined ? sql`` : sql` AND o.ts >= ${now - windowDays * DAY_MS}`
}

function compileRule(rule: AudienceRule, now: number): SQL {
	const guestId = sql`${customers.id}`
	switch (rule.field) {
		case 'orders_count':
			return compare(
				rule.op,
				sql`(SELECT COUNT(*) FROM ${countedOrdersSql()} o WHERE o.customer_id = ${guestId}${windowFilter(rule.windowDays, now)}${locationFilter(rule.locationIds)})`,
				rule.value,
			)
		case 'spend':
			return compare(
				rule.op,
				sql`COALESCE((SELECT SUM(o.net) FROM ${countedOrdersSql()} o WHERE o.customer_id = ${guestId}${windowFilter(rule.windowDays, now)}${locationFilter(rule.locationIds)}), 0)`,
				rule.value,
			)
		case 'days_since_last_order': {
			const last = sql`(SELECT MAX(o.ts) FROM ${countedOrdersSql()} o WHERE o.customer_id = ${guestId}${locationFilter(rule.locationIds)})`
			const age = sql`(${now} - ${last})`
			const body =
				rule.op === 'gte'
					? sql`${age} >= ${rule.value * DAY_MS}`
					: rule.op === 'lte'
						? sql`${age} <= ${rule.value * DAY_MS}`
						: sql`CAST(${age} / ${DAY_MS} AS INTEGER) = ${rule.value}`
			// Only guests who ordered at least once have a last order.
			return sql`(${last} IS NOT NULL AND ${body})`
		}
		case 'top_spenders': {
			const since = now - rule.windowDays * DAY_MS
			return sql`${guestId} IN (
				SELECT ranked.customer_id FROM (
					SELECT o.customer_id AS customer_id, SUM(o.net) AS spent,
						RANK() OVER (ORDER BY SUM(o.net) DESC) AS place,
						COUNT(*) OVER () AS spenders
					FROM ${countedOrdersSql()} o
					WHERE o.ts >= ${since}
					GROUP BY o.customer_id
				) ranked
				WHERE ranked.spent > 0
					AND ranked.place <= (ranked.spenders * ${rule.percent} + 99) / 100
			)`
		}
		case 'visits':
			return compare(
				rule.op,
				sql`COALESCE((SELECT SUM(g.visits) FROM rsv_guests g WHERE g.customer_id = ${guestId} AND g.merged_into_id IS NULL AND g.erased_at IS NULL), 0)`,
				rule.value,
			)
		case 'days_since_last_visit': {
			const last = sql`(SELECT MAX(g.last_visit_at) FROM rsv_guests g WHERE g.customer_id = ${guestId} AND g.merged_into_id IS NULL AND g.erased_at IS NULL)`
			const age = sql`(${now} - ${last})`
			const body =
				rule.op === 'gte'
					? sql`${age} >= ${rule.value * DAY_MS}`
					: rule.op === 'lte'
						? sql`${age} <= ${rule.value * DAY_MS}`
						: sql`CAST(${age} / ${DAY_MS} AS INTEGER) = ${rule.value}`
			return sql`(${last} IS NOT NULL AND ${body})`
		}
		case 'has_upcoming_reservation': {
			const upcoming = sql`EXISTS (SELECT 1 FROM rsv_reservations r JOIN rsv_guests g ON g.id = r.guest_id WHERE g.customer_id = ${guestId} AND g.merged_into_id IS NULL AND g.erased_at IS NULL AND r.start_at >= ${now} AND r.status IN ('booked', 'confirmed', 'pending_payment'))`
			return rule.value ? upcoming : sql`NOT ${upcoming}`
		}
		case 'loyalty_member': {
			const member = sql`EXISTS (SELECT 1 FROM loyalty_members lm WHERE lm.customer_id = ${guestId} AND lm.status = 'active')`
			return rule.value ? member : sql`NOT ${member}`
		}
		case 'loyalty_points':
			return compare(
				rule.op,
				sql`COALESCE((SELECT b.points - b.reserved FROM loyalty_members lm JOIN loyalty_balances b ON b.member_id = lm.id WHERE lm.customer_id = ${guestId} AND lm.status = 'active'), 0)`,
				rule.value,
			)
		case 'loyalty_near_reward':
			// Within `withinPercent` of the cheapest active reward, not past it.
			return sql`EXISTS (
				SELECT 1 FROM loyalty_members lm
				JOIN loyalty_balances b ON b.member_id = lm.id
				WHERE lm.customer_id = ${guestId} AND lm.status = 'active'
					AND (b.points - b.reserved) < (SELECT MIN(points_cost) FROM loyalty_rewards WHERE status = 'active')
					AND (b.points - b.reserved) * 100 >= (SELECT MIN(points_cost) FROM loyalty_rewards WHERE status = 'active') * ${100 - rule.withinPercent}
			)`
		case 'phone_verified':
			return rule.value
				? sql`COALESCE(${customers.phoneVerified}, 0) = 1`
				: sql`COALESCE(${customers.phoneVerified}, 0) = 0`
		case 'joined_within_days':
			return sql`COALESCE(${customers.createdAt}, 0) * 1000 >= ${now - rule.value * DAY_MS}`
	}
}

/** The condition on `customers` for a definition ("all of" joins with AND, "any of" with OR). */
export function compileAudience(
	definition: AudienceDefinition,
	now: number = Date.now(),
): SQL {
	const parts = definition.rules.map((rule) => compileRule(rule, now))
	return sql`(${sql.join(parts, definition.match === 'all' ? sql` AND ` : sql` OR `)})`
}

/**
 * A location-scoped operator stays inside their scope: every order rule must
 * name locations, all inside it (`location_out_of_scope`). Org-wide tokens pass
 * `undefined`.
 */
export function audienceOutOfScope(
	definition: AudienceDefinition,
	scopeLocationIds: readonly string[] | undefined,
): boolean {
	if (!scopeLocationIds) return false
	const scope = new Set(scopeLocationIds)
	for (const rule of definition.rules) {
		const orderRule =
			rule.field === 'orders_count' ||
			rule.field === 'spend' ||
			rule.field === 'days_since_last_order'
		if (orderRule && !rule.locationIds) return true
		// An order rule that cannot be narrowed to a place cannot be scoped.
		if (rule.field === 'top_spenders') return true
	}
	return audienceLocationIds(definition).some((id) => !scope.has(id))
}
