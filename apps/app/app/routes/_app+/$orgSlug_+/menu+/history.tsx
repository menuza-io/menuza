import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { auditService, AuditAction } from '@repo/audit'
import { db, desc, eq, MenuSnapshot, User } from '@repo/database'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Form, Link, type ActionFunctionArgs, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireMenuHistoryAccess } from '#app/utils/menu/menu-feature-access.server.ts'
import {
	createMenuSnapshot,
	MenuSnapshotError,
	restoreMenuSnapshot,
} from '#app/utils/menu/snapshot.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const SnapshotAction = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('snapshot'), label: z.string().optional() }),
	z.object({
		intent: z.literal('restore'),
		snapshotId: z.string().min(1),
		removeAdded: z
			.union([z.literal('true'), z.literal('false')])
			.optional()
			.transform((v) => v === 'true'),
	}),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuHistoryAccess(request, organization.id)

	const rows = await db
		.select({
			id: MenuSnapshot.id,
			reason: MenuSnapshot.reason,
			label: MenuSnapshot.label,
			itemCount: MenuSnapshot.itemCount,
			createdAt: MenuSnapshot.createdAt,
			createdById: MenuSnapshot.createdById,
			creatorName: User.name,
		})
		.from(MenuSnapshot)
		.leftJoin(User, eq(MenuSnapshot.createdById, User.id))
		.where(eq(MenuSnapshot.organizationId, organization.id))
		.orderBy(desc(MenuSnapshot.createdAt))
		.limit(200)

	return { snapshots: rows, organization }
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuHistoryAccess(request, organization.id)
	const userId = await requireMenuWrite(request, organization.id)

	const formData = await request.formData()
	const parsed = SnapshotAction.safeParse(Object.fromEntries(formData))
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	if (parsed.data.intent === 'snapshot') {
		const id = await createMenuSnapshot({
			organizationId: organization.id,
			reason: 'manual',
			userId,
			label: parsed.data.label,
		})
		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId,
			organizationId: organization.id,
			resourceType: 'menu_snapshot',
			resourceId: id,
			details: 'Manual menu snapshot',
			metadata: { label: parsed.data.label ?? null },
			request,
		})
		return Response.json({ ok: true, snapshotId: id })
	}

	try {
		const result = await restoreMenuSnapshot({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			snapshotId: parsed.data.snapshotId,
			userId,
			request,
			removeAdded: parsed.data.removeAdded ?? false,
		})
		return Response.json({ ok: true, ...result })
	} catch (error) {
		if (error instanceof MenuSnapshotError) {
			if (error.code === 'not_found') throw new Response('Not Found', { status: 404 })
			if (error.code === 'restore_in_progress') {
				return Response.json({ error: error.code }, { status: 409 })
			}
		}
		throw error
	}
}

export default function MenuHistoryPage() {
	const { _ } = useLingui()
	const { snapshots } = useLoaderData<typeof loader>()

	return (
		<Frame>
			<PageHeader
				title={_(t`History`)}
				description={_(
					t`Snapshots of your menu. Compare versions and restore when needed.`,
				)}
				actions={
					<Form method="post">
						<input type="hidden" name="intent" value="snapshot" />
						<Button type="submit">
							<Icon name="history" className="size-4" />
							<Trans>Take snapshot</Trans>
						</Button>
					</Form>
				}
			/>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>When</Trans>
						</TableHead>
						<TableHead>
							<Trans>Reason</Trans>
						</TableHead>
						<TableHead>
							<Trans>Dishes</Trans>
						</TableHead>
						<TableHead>
							<Trans>By</Trans>
						</TableHead>
						<TableHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{snapshots.map((row) => (
						<TableRow key={row.id}>
							<TableCell>{row.createdAt.toLocaleString()}</TableCell>
							<TableCell>{row.label ?? row.reason}</TableCell>
							<TableCell>{row.itemCount}</TableCell>
							<TableCell>{row.creatorName ?? '—'}</TableCell>
							<TableCell className="text-right">
								<Button
									variant="outline"
									size="sm"
									render={<Link to={row.id} prefetch="intent" />}
								>
									<Trans>Compare</Trans>
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Frame>
	)
}
