import { db, eq, and, Organization, UserOrganization } from '@repo/database'
import { staffExportFileSchema, type StaffExportFile } from '@repo/staffing'
import { z } from 'zod'
import {
	enqueueStaffingOutbox,
	flushStaffingOutboxFor,
} from './outbox.server.ts'
import { postRegionalStaffInternal } from './regional-internal.server.ts'

/**
 * Data-subject requests (erasure and access) for the regional staff records
 * that may be linked to a control-plane login.
 *
 * Erasure: before an account is deleted, every organization the user belongs to
 * that has a regional database gets an `erase_user` event in the staffing
 * outbox (ids only). The regional node anonymizes the linked staff row: names,
 * contact details, birth date, address, notes and the values inside its audit
 * rows go, and the wage history stays under a pseudonym for its retention period.
 *
 * Access: a US-region record is generated in-region and attached to the user's
 * export file. A Saudi-region record is NOT fetched through the US App; the
 * export names the organization and says it is delivered in-region by its
 * administrators (`GET /operator/staff/export`, browser-direct).
 */

async function provisionedMemberships(userId: string) {
	return db
		.select({
			organizationId: Organization.id,
			organizationName: Organization.name,
			dataRegion: Organization.dataRegion,
		})
		.from(UserOrganization)
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(Organization.hasProvisionedDb, true),
			),
		)
}

/**
 * Queues `erase_user` for every provisioned organization the user belongs to
 * (active or not: a removed member's staff link may still be pending). Throws if
 * a row cannot be written, so the caller can stop before deleting the account.
 */
export async function enqueueStaffErasureForUser(
	userId: string,
): Promise<string[]> {
	const memberships = await provisionedMemberships(userId)
	const queued: string[] = []
	for (const membership of memberships) {
		const id = await enqueueStaffingOutbox({
			organizationId: membership.organizationId,
			kind: 'erase_user',
			payload: { userId },
		})
		if (id) queued.push(membership.organizationId)
	}
	return queued
}

/** Best-effort immediate delivery of the events queued above. Never throws. */
export async function flushStaffErasure(
	userId: string,
	organizationIds: readonly string[],
): Promise<void> {
	for (const organizationId of organizationIds) {
		await flushStaffingOutboxFor(organizationId, userId)
	}
}

export type StaffRecordExport =
	| {
			organizationId: string
			organizationName: string
			status: 'included'
			record: StaffExportFile
	  }
	| {
			organizationId: string
			organizationName: string
			status: 'regional_delivery_required'
			note: string
	  }
	| {
			organizationId: string
			organizationName: string
			status: 'unavailable'
			note: string
	  }

const exportResponseSchema = z.object({
	export: staffExportFileSchema.nullable(),
})

/**
 * The staff-record section of a user's data export. Organizations without a
 * linked staff record contribute nothing (US) or a pointer (Saudi region).
 * A node that is down yields an `unavailable` entry rather than failing the
 * whole export.
 */
export async function collectStaffExportsForUser(
	userId: string,
): Promise<StaffRecordExport[]> {
	const memberships = await provisionedMemberships(userId)
	// Nodes are asked in parallel so one slow region does not stack up delays.
	const entries = await Promise.all(
		memberships.map(async (membership): Promise<StaffRecordExport | null> => {
			const base = {
				organizationId: membership.organizationId,
				organizationName: membership.organizationName,
			}
			if (membership.dataRegion === 'ksa') {
				return {
					...base,
					status: 'regional_delivery_required',
					note: 'If this organization keeps a staff record about you, it is held in its Saudi Arabia data region and is not exported through the US servers. Ask the organization administrators for a copy; they can export it in-region.',
				}
			}
			try {
				const response = await postRegionalStaffInternal({
					dataRegion: membership.dataRegion,
					path: 'export-user',
					body: { orgId: membership.organizationId, userId },
					timeoutMs: 15_000,
				})
				if (!response.ok) throw new Error(`status ${response.status}`)
				const parsed = exportResponseSchema.parse(await response.json())
				return parsed.export
					? { ...base, status: 'included', record: parsed.export }
					: null
			} catch (error) {
				console.error('Staff record export failed', {
					organizationId: membership.organizationId,
					error: error instanceof Error ? error.name : 'unknown',
				})
				return {
					...base,
					status: 'unavailable',
					note: 'A staff record could not be retrieved right now. Request the export again later.',
				}
			}
		}),
	)
	return entries.filter((entry): entry is StaffRecordExport => entry !== null)
}
