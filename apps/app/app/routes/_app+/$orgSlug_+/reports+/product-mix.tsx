import { Trans, useLingui } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { and, asc, db, eq, inArray, OrganizationLocation } from '@repo/database'
import {
	buildProductMixTree,
	PRODUCT_MIX_LEVELS,
	productMixCsv,
	productMixCurrencies,
	type ProductMixLevel,
	type ProductMixRow,
} from '@repo/reports/product-mix'
import { Button } from '@repo/ui/button'
import { Switch } from '@repo/ui/switch'
import { WorkspacePage } from '@repo/ui/workspace'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import {
	ProductMixTable,
	useLevelLabels,
} from '#app/components/reports/product-mix-table.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/product-mix.ts'

const PRESETS = [
	'last_7_days',
	'last_30_days',
	'month_to_date',
	'last_complete_month',
	'last_3_months',
] as const
type Preset = (typeof PRESETS)[number]

const CHANNELS = [
	'online_menu',
	'qr_table',
	'qr_poster',
	'drop',
	'station_counter',
	'station_phone',
] as const

/** Levels shown to start with; the option levels are opt-in. */
const DEFAULT_LEVELS: ProductMixLevel[] = ['menu', 'category', 'dish']

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
	})
	const locationIds = await resolveReservationsLocationIds(
		userId,
		organization.id,
	)
	const locationFilter =
		locationIds === null
			? eq(OrganizationLocation.organizationId, organization.id)
			: locationIds.length === 0
				? eq(OrganizationLocation.id, '')
				: and(
						eq(OrganizationLocation.organizationId, organization.id),
						inArray(OrganizationLocation.id, locationIds),
					)
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(locationFilter)
		.orderBy(asc(OrganizationLocation.name))
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	return {
		orgSlug: params.orgSlug,
		tokenUrl: `/${params.orgSlug}/reports/token`,
		tenantApiUrl,
		locations,
	}
}

function download(name: string, csv: string) {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = name
	link.click()
	URL.revokeObjectURL(url)
}

export default function ProductMixPage() {
	const { tokenUrl, tenantApiUrl, locations } = useLoaderData<typeof loader>()
	const { t } = useLingui()
	const levelLabel = useLevelLabels()
	const [preset, setPreset] = useState<Preset>('last_30_days')
	const [locationId, setLocationId] = useState('')
	const [channel, setChannel] = useState('')
	const [levels, setLevels] = useState<ProductMixLevel[]>(DEFAULT_LEVELS)
	const [showPercentages, setShowPercentages] = useState(true)
	const [rows, setRows] = useState<ProductMixRow[] | null>(null)
	const [truncated, setTruncated] = useState(false)
	const [failed, setFailed] = useState(false)

	const load = useCallback(async () => {
		setFailed(false)
		setRows(null)
		try {
			const tokenResponse = await fetch(tokenUrl)
			const tokenBody = (await tokenResponse.json()) as { token?: string }
			if (!tokenResponse.ok || typeof tokenBody.token !== 'string') {
				throw new Error('token')
			}
			const query = new URLSearchParams({ preset })
			try {
				query.set(
					'timeZone',
					Intl.DateTimeFormat().resolvedOptions().timeZone,
				)
			} catch {
				// The region falls back to UTC.
			}
			if (locationId) query.set('locationIds', locationId)
			if (channel) query.set('channels', channel)
			const response = await fetch(
				`${tenantApiUrl}/analytics/product-mix?${query.toString()}`,
				{ headers: { Authorization: `Bearer ${tokenBody.token}` } },
			)
			if (!response.ok) throw new Error('run')
			const body = (await response.json()) as {
				rows?: ProductMixRow[]
				truncated?: boolean
			}
			setRows(body.rows ?? [])
			setTruncated(body.truncated === true)
		} catch {
			setFailed(true)
			setRows([])
		}
	}, [channel, locationId, preset, tenantApiUrl, tokenUrl])

	useEffect(() => {
		void load()
	}, [load])

	const currencies = useMemo(() => productMixCurrencies(rows ?? []), [rows])
	const trees = useMemo(
		() =>
			currencies.map((currency) =>
				buildProductMixTree(rows ?? [], levels, currency),
			),
		[currencies, rows, levels],
	)

	const toggle = (level: ProductMixLevel) =>
		setLevels((current) =>
			current.includes(level)
				? current.filter((item) => item !== level)
				: [...current, level],
		)

	const presetLabels: Record<Preset, string> = {
		last_7_days: t`Last 7 days`,
		last_30_days: t`Last 30 days`,
		month_to_date: t`Month to date`,
		last_complete_month: t`Last month`,
		last_3_months: t`Last 3 months`,
	}
	const channelLabels: Record<(typeof CHANNELS)[number], string> = {
		online_menu: t`Online menu`,
		qr_table: t`QR table`,
		qr_poster: t`QR poster`,
		drop: t`Drop`,
		station_counter: t`Station counter`,
		station_phone: t`Station phone order`,
	}

	return (
		<WorkspacePage>
			<div className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					<Trans>Product mix</Trans>
				</h1>
				<p className="text-muted-foreground max-w-2xl text-sm">
					<Trans>
						What each menu, category, dish and option sold, and its share of
						sales. Categories are the ones the dishes were sold under at the
						time. Sales are after discounts, before tax and tips. Option sales
						are already part of their dish.
					</Trans>
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3" data-testid="product-mix-filters">
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Period</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={preset}
						onChange={(event) => setPreset(event.target.value as Preset)}
					>
						{PRESETS.map((item) => (
							<option key={item} value={item}>
								{presetLabels[item]}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Location</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={locationId}
						onChange={(event) => setLocationId(event.target.value)}
					>
						<option value="">{t`All locations`}</option>
						{locations.map((location) => (
							<option key={location.id} value={location.id}>
								{location.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground text-xs">
						<Trans>Channel</Trans>
					</span>
					<select
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={channel}
						onChange={(event) => setChannel(event.target.value)}
					>
						<option value="">{t`All channels`}</option>
						{CHANNELS.map((item) => (
							<option key={item} value={item}>
								{channelLabels[item]}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2 pb-1 text-sm">
					<Switch
						checked={showPercentages}
						onCheckedChange={setShowPercentages}
						aria-label={t`Show percentages`}
					/>
					<Trans>Show percentages</Trans>
				</label>
			</div>

			<fieldset className="flex flex-wrap items-center gap-4">
				<legend className="text-muted-foreground mb-1 text-xs">
					<Trans>Levels to show (the total does not change)</Trans>
				</legend>
				{PRODUCT_MIX_LEVELS.map((level) => (
					<label key={level} className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={levels.includes(level)}
							onChange={() => toggle(level)}
							data-testid={`level-${level}`}
						/>
						{levelLabel(level)}
					</label>
				))}
				<Button
					variant="outline"
					size="sm"
					onClick={() => setLevels(['category'])}
					data-testid="preset-sales-by-category"
				>
					<Trans>Sales by category</Trans>
				</Button>
			</fieldset>

			{failed ? (
				<p className="text-destructive text-sm">
					<Trans>Could not load the product mix from your region.</Trans>
				</p>
			) : null}
			{truncated ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						This period has more sales than a report reads. Figures cover the
						most recent ones.
					</Trans>
				</p>
			) : null}
			{rows === null ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : trees.length === 0 && !failed ? (
				<p data-testid="product-mix-empty">
					<Trans>Nothing sold in this period.</Trans>
				</p>
			) : (
				trees.map((tree) => (
					<section
						key={tree.currency}
						className="flex flex-col gap-3"
						aria-label={tree.currency}
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h2 className="text-lg font-medium">{tree.currency}</h2>
							<div className="flex flex-wrap gap-2">
								{PRODUCT_MIX_LEVELS.filter((level) =>
									levels.includes(level),
								).map((level) => (
									<Button
										key={level}
										variant="outline"
										size="sm"
										onClick={() =>
											download(
												`product-mix-${level}-${tree.currency}.csv`,
												productMixCsv(tree, level, showPercentages),
											)
										}
									>
										<Trans>Export {levelLabel(level)}</Trans>
									</Button>
								))}
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										download(
											`product-mix-${tree.currency}.csv`,
											productMixCsv(tree, undefined, showPercentages),
										)
									}
								>
									<Trans>Export all in one file</Trans>
								</Button>
							</div>
						</div>
						<ProductMixTable
							tree={tree}
							showPercentages={showPercentages}
							levelLabel={levelLabel}
						/>
					</section>
				))
			)}
		</WorkspacePage>
	)
}
