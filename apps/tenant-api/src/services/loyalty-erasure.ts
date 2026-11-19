import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
	loyaltyIdempotencyKeys,
	loyaltyLedger,
	loyaltyMemberBindings,
	loyaltyMemberCodes,
	loyaltyMembers,
	loyaltyNotices,
	loyaltyReferralCodes,
	loyaltyReferrals,
	loyaltyWelcomeGrants,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import { closeMemberAccessInTx } from './loyalty-member-service.ts'

/**
 * The loyalty part of person erasure. `erasePerson` calls it inside the same
 * regional transaction, before the customer rows are deleted.
 *
 * The member row stays: `loyalty_members` is append-only (no delete) and the
 * ledger, purchases and redemptions keep their anonymous owner for the books.
 * Everything that could still act as or point at the person goes:
 *
 * - member codes and till bindings are deleted (used codes included: a stored
 *   hash serves nobody once the row is gone), pending approvals cancelled and
 *   unbound holds released (`closeMemberAccessInTx`);
 * - the member row is marked `erased`, unlinked from the customer and stamped
 *   (the `loyalty_members_erased_final` trigger then keeps it closed, so a
 *   retried POS upload or an old binding can never resurrect it);
 * - operator notes on the member's ledger entries and on refunds of orders,
 *   tabs and till sales the member earned or spent on are nulled (the only
 *   update the append-only triggers allow);
 * - audit rows about the member, its balance, its purchases and redemptions
 *   and those refunds are redacted (they carry the operators' notes);
 * - stored idempotent responses linked to the member are deleted.
 *
 * Balances, ledger deltas, purchases and redemptions are not touched: they no
 * longer identify anyone and are the justified financial trail.
 */
export async function eraseLoyaltyMembersInTx(
	tx: LoyaltyTx,
	input: { customerIds: readonly string[]; now: number },
): Promise<{ membersErased: number }> {
	if (input.customerIds.length === 0) return { membersErased: 0 }
	await queryInChunks(input.customerIds, async (chunk) => {
		await tx
			.update(loyaltyReferrals)
			.set({
				friendCustomerId: null,
				deviceHash: null,
				updatedAt: input.now,
			})
			.where(inArray(loyaltyReferrals.friendCustomerId, chunk))
			.run()
		return []
	})
	const members = await queryInChunks(input.customerIds, (chunk) =>
		tx
			.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
			.from(loyaltyMembers)
			.where(inArray(loyaltyMembers.customerId, chunk))
			.all(),
	)
	for (const member of members) {
		// Unused codes, bindings, notices, referral codes, pending approvals and
		// unbound holds first: nothing may act as the member once erased.
		await closeMemberAccessInTx(tx, member.id, input.now)
		await tx
			.delete(loyaltyNotices)
			.where(eq(loyaltyNotices.memberId, member.id))
		await tx
			.delete(loyaltyReferralCodes)
			.where(eq(loyaltyReferralCodes.memberId, member.id))
		await tx
			.update(loyaltyWelcomeGrants)
			.set({ memberId: null })
			.where(eq(loyaltyWelcomeGrants.memberId, member.id))
		await tx
			.update(loyaltyReferrals)
			.set({ referrerMemberId: null, updatedAt: input.now })
			.where(eq(loyaltyReferrals.referrerMemberId, member.id))
		await tx
			.update(loyaltyReferrals)
			.set({
				friendMemberId: null,
				friendCustomerId: null,
				deviceHash: null,
				updatedAt: input.now,
			})
			.where(eq(loyaltyReferrals.friendMemberId, member.id))
		await tx
			.delete(loyaltyMemberCodes)
			.where(eq(loyaltyMemberCodes.memberId, member.id))
		await tx
			.delete(loyaltyMemberBindings)
			.where(eq(loyaltyMemberBindings.memberId, member.id))
		if (member.status !== 'erased') {
			await tx
				.update(loyaltyMembers)
				.set({
					status: 'erased',
					customerId: null,
					erasedAt: input.now,
					updatedAt: input.now,
				})
				.where(eq(loyaltyMembers.id, member.id))
		}
		await tx
			.update(loyaltyLedger)
			.set({ note: null })
			.where(
				and(
					eq(loyaltyLedger.memberId, member.id),
					isNotNull(loyaltyLedger.note),
				),
			)
		await tx
			.delete(loyaltyIdempotencyKeys)
			.where(eq(loyaltyIdempotencyKeys.memberId, member.id))
		// Refund rows have no member link, and `purchase_id` is null when the
		// member only spent on the source; the source itself is the link.
		const memberSources = sql`
			SELECT source_type, source_id FROM loyalty_purchases WHERE member_id = ${member.id}
			UNION
			SELECT source_type, source_id FROM loyalty_redemptions
			WHERE member_id = ${member.id} AND source_id IS NOT NULL`
		await tx.run(
			sql`UPDATE loyalty_refunds SET note = NULL
				WHERE note IS NOT NULL AND (source_type, source_id) IN (${memberSources})`,
		)
		await tx.run(
			sql`UPDATE loyalty_audit_log SET changes = '{"redacted":true}'
				WHERE changes IS NOT NULL AND changes <> '{"redacted":true}' AND (
					(entity_type IN ('member', 'balance') AND entity_id = ${member.id})
					OR (entity_type = 'purchase' AND entity_id IN (
						SELECT id FROM loyalty_purchases WHERE member_id = ${member.id}))
					OR (entity_type = 'redemption' AND entity_id IN (
						SELECT id FROM loyalty_redemptions WHERE member_id = ${member.id}))
					OR (entity_type = 'refund' AND entity_id IN (
						SELECT id FROM loyalty_refunds
						WHERE (source_type, source_id) IN (${memberSources})))
				)`,
		)
	}
	return { membersErased: members.length }
}
