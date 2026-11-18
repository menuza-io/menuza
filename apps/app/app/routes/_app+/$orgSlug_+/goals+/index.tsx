import { useEffect, useState } from 'react'
import { parseWithZod } from '@conform-to/zod/v4'
import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { WorkspacePage } from '@repo/ui/workspace'
import { data, Form, useActionData, useLoaderData } from 'react-router'
import { z } from 'zod'
import { hasAdminReportAccess } from '#app/utils/staffing/report-grants.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { loadSalesGoalsAccess } from '#app/utils/goals/goals-access.server.ts'
import {
	loadLocationGoalProgress,
	upsertSalesGoal,
} from '#app/utils/goals/sales-goals.server.ts'
import { type LocationGoalProgress } from '#app/utils/goals/goals.ts'
import { type Route } from './+types/index.ts'

const goalSchema = z.object({
	intent: z.literal('set-goal'),
	locationId: z.string().min(1),
	goalMajor: z
		.string()
		.transform((value) => Number(value))
		.pipe(z.number().positive()),
	currency: z.string().min(3).max(3).default('USD'),
})

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		dataRegion: true,
	})
	const month = new Date().toISOString().slice(0, 7)
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	const [progress, access, canEdit] = await Promise.all([
		loadLocationGoalProgress({
			organizationId: organization.id,
			month,
			actualByLocation: new Map(),
			locationIds,
		}),
		loadSalesGoalsAccess({
			userId,
			organizationId: organization.id,
			orgSlug: params.orgSlug,
			dataRegion: organization.dataRegion,
		}),
		hasAdminReportAccess(userId, organization.id),
	])
	return {
		orgSlug: params.orgSlug,
		month,
		progress,
		access,
		canEdit,
		locationIds,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	if (!(await hasAdminReportAccess(userId, organization.id))) {
		return data({ error: 'forbidden' as const }, { status: 403 })
	}
	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: goalSchema })
	if (submission.status !== 'success') {
		return data({ error: 'invalid' as const }, { status: 400 })
	}
	const { locationId, goalMajor, currency } = submission.value
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	if (
		locationIds !== null &&
		(locationIds.length === 0 || !locationIds.includes(locationId))
	) {
		return data({ error: 'forbidden' as const }, { status: 403 })
	}
	const month = new Date().toISOString().slice(0, 7)
	await upsertSalesGoal({
		organizationId: organization.id,
		locationId,
		month,
		goalMinor: Math.round(goalMajor * 100),
		currency: currency.toUpperCase(),
	})
	return data({ ok: true as const })
}

export default function GoalsPage() {
	const {
		month,
		progress: initial,
		access,
		canEdit,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const [progress, setProgress] = useState(initial)

	useEffect(() => {
		if (!access.available) return
		let cancelled = false
		const load = async () => {
			try {
				const tokenRes = await fetch(access.tokenUrl)
				const tokenBody = (await tokenRes.json()) as { token?: string }
				if (!tokenRes.ok || typeof tokenBody.token !== 'string') return
				const salesRes = await fetch(
					`${access.tenantApiUrl}/analytics/month-sales?salesBasis=net`,
					{
						headers: { Authorization: `Bearer ${tokenBody.token}` },
					},
				)
				if (!salesRes.ok) return
				const salesBody = (await salesRes.json()) as {
					byLocation?: Record<string, number>
				}
				if (cancelled) return
				setProgress((rows) =>
					rows.map((row) => ({
						...row,
						actualMinor:
							salesBody.byLocation?.[row.locationId] ?? row.actualMinor,
					})),
				)
			} catch {
				// keep server progress
			}
		}
		void load()
		return () => {
			cancelled = true
		}
	}, [access, actionData])

	return (
		<WorkspacePage>
			<h1 className="text-2xl font-semibold tracking-tight">
				<Trans>Sales goals</Trans>
			</h1>
			<p className="text-muted-foreground mb-4 text-sm">
				<Trans>Monthly targets for {month}.</Trans>
			</p>
			{canEdit ? (
				<Form method="post" className="mb-6 flex flex-wrap items-end gap-2">
					<input type="hidden" name="intent" value="set-goal" />
					<label className="text-sm">
						<Trans>Location</Trans>
						<select
							name="locationId"
							className="border-input ml-2 rounded border px-2 py-1"
							data-testid="goal-location-select"
						>
							{progress.map((row) => (
								<option key={row.locationId} value={row.locationId}>
									{row.locationName}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<Trans>Goal</Trans>
						<Input
							name="goalMajor"
							type="number"
							min={1}
							step="0.01"
							className="ml-2 w-28"
							data-testid="goal-amount-input"
						/>
					</label>
					<input type="hidden" name="currency" value="USD" />
					<Button type="submit" data-testid="goal-save">
						<Trans>Save goal</Trans>
					</Button>
				</Form>
			) : null}
			<ul className="space-y-3">
				{progress.map((row) => (
					<GoalRow key={row.locationId} row={row} />
				))}
			</ul>
		</WorkspacePage>
	)
}

function GoalRow({ row }: { row: LocationGoalProgress }) {
	return (
		<li
			className="border-border rounded-lg border p-4"
			data-testid={`goal-${row.locationId}`}
		>
			<div className="font-medium">{row.locationName}</div>
			{row.goalMinor === null ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Set a monthly goal to track progress here.</Trans>
				</p>
			) : (
				<p className="text-sm" data-testid="goal-progress-line">
					<Trans>
						Actual {(row.actualMinor / 100).toFixed(2)} / goal{' '}
						{(row.goalMinor / 100).toFixed(2)} {row.currency}
					</Trans>
				</p>
			)}
		</li>
	)
}
