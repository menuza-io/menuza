import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ACCOUNTING_LAYOUTS,
	buildJournalDay,
	entryFromDay,
	mappableLines,
	type AccountingDayFacts,
	type AccountingLayout,
	type AccountMapping,
	type JournalDay,
} from '@repo/reports'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage } from '@repo/ui/workspace'
import { useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { saveBlob } from '#app/components/exports/use-chunked-export.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { mergeAccountingDays } from '#app/utils/reports/accounting-days.ts'

type Props = {
	orgSlug: string
	mapping: AccountMapping
	settings: { layout: AccountingLayout; bookkeeperEmail: string | null; weeklyEmail: boolean }
	timeZone: string
	canReadPayments: boolean
	defaultFrom: string
	defaultTo: string
	tokenUrl: string
	tenantApiUrl: string
}

const LAYOUT_LABELS = {
	quickbooks: msg`QuickBooks`,
	xero: msg`Xero`,
	generic: msg`Generic CSV`,
} as const

function money(minor: number, currency: string, locale: string) {
	try {
		return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

/**
 * Reports, Accounting (#189): the day's journal per location (sales by
 * category, discounts, tax by rate, tips, service fees, gift cards, refunds,
 * payments by tender, processing fees and the amount paid out), the account
 * each line goes to, and a file for QuickBooks, Xero or a generic CSV. Figures
 * are totals read from your own region. A day is final only after it closes; an
 * earlier day that changed since it was exported goes out as an adjusting
 * entry. A day that does not balance shows its difference.
 */
export function AccountingScreen(props: Props) {
	const { _, i18n } = useLingui()
	const [from, setFrom] = useState(props.defaultFrom)
	const [to, setTo] = useState(props.defaultTo)
	const [layout, setLayout] = useState<AccountingLayout>(props.settings.layout)
	const [days, setDays] = useState<JournalDay[] | null>(null)
	const [payoutsHidden, setPayoutsHidden] = useState(false)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [mapping, setMapping] = useState<AccountMapping>(props.mapping)
	const [email, setEmail] = useState(props.settings.bookkeeperEmail ?? '')
	const [weekly, setWeekly] = useState(props.settings.weeklyEmail)
	const exporter = useFetcher<{
		ok: boolean
		error?: string
		csv?: string
		filename?: string
		unchanged?: number
		adjustments?: number
		provisional?: number
		outOfBalance?: number
		entries?: number
	}>()
	const settingsFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const mappingFetcher = useFetcher<{ ok: boolean }>()

	const run = async () => {
		setLoading(true)
		setError(null)
		try {
			// The location figures come straight from the region, with the member's token.
			const tokenResponse = await fetch(props.tokenUrl)
			const tokenBody = (await tokenResponse.json()) as { token?: string }
			if (!tokenResponse.ok || !tokenBody.token) throw new Error('token')
			const response = await fetch(
				`${props.tenantApiUrl.replace(/\/+$/, '')}/analytics/accounting-daily?from=${from}&to=${to}`,
				{ headers: { Authorization: `Bearer ${tokenBody.token}` } },
			)
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string }
				throw new Error(body.message ?? 'region')
			}
			const regional = ((await response.json()) as { days: AccountingDayFacts[] }).days
			// The payout and its fees are the Payments page's own data.
			const providerResponse = await fetch(`/${props.orgSlug}/reports/accounting`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ intent: 'provider', from, to }),
			})
			const providerBody = (await providerResponse.json()) as {
				provider?: AccountingDayFacts[]
				payoutsHidden?: boolean
			}
			setPayoutsHidden(providerBody.payoutsHidden === true)
			setDays(
				mergeAccountingDays(regional, providerBody.provider ?? []).map(buildJournalDay),
			)
		} catch (failure) {
			setDays(null)
			setError(failure instanceof Error ? failure.message : 'failed')
		} finally {
			setLoading(false)
		}
	}

	const entries = (days ?? []).map((day) => entryFromDay(day))
	const lines = mappableLines(entries)
	const done = exporter.state === 'idle' && exporter.data?.ok ? exporter.data : null

	return (
		<WorkspacePage>
			<PageHeader
				title={<Trans>Accounting</Trans>}
				description={
					<Trans>
						Your daily sales as a journal for your accounting software: one
						entry per location and day that balances, with the account each
						line goes to. Figures are totals from your own region; no guest
						names or contact details are in the file.
					</Trans>
				}
				actions={
					<Button variant="outline" render={<Link to={`/${props.orgSlug}/reports`} />}>
						<Trans>Back to reports</Trans>
					</Button>
				}
			/>

			<Card>
				<CardHeader>
					<CardTitle><Trans>Pick the days</Trans></CardTitle>
					<CardDescription>
						<Trans>
							A day is the location&apos;s own business day. Days that are not
							over yet are shown as provisional and are never marked as exported.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap items-end gap-3">
					<TextField
						label={_(msg`From`)}
						type="date"
						value={from}
						max={to}
						onChange={(event) => setFrom(event.target.value)}
						data-testid="accounting-from"
					/>
					<TextField
						label={_(msg`To`)}
						type="date"
						value={to}
						min={from}
						onChange={(event) => setTo(event.target.value)}
						data-testid="accounting-to"
					/>
					<SelectField
						label={_(msg`File layout`)}
						options={ACCOUNTING_LAYOUTS.map((value) => ({
							value,
							label: _(LAYOUT_LABELS[value]),
						}))}
						value={layout}
						onValueChange={(next) => setLayout(next as AccountingLayout)}
						testId="accounting-layout"
					/>
					<Button onClick={() => void run()} disabled={loading} data-testid="accounting-preview">
						<Trans>Preview journal</Trans>
					</Button>
				</CardContent>
			</Card>

			{error ? (
				<Alert variant="destructive" data-testid="accounting-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<Trans>The journal could not be loaded: {error}</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{payoutsHidden && days ? (
				<Alert data-testid="accounting-no-payouts">
					<Icon name="info" />
					<AlertDescription>
						<Trans>
							You do not have access to payments, so the payout and processing fee
							lines are left out.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{days ? (
				<div className="flex flex-col gap-4" data-testid="accounting-days">
					{days.length === 0 ? (
						<p className="text-muted-foreground text-sm"><Trans>No sales in these days.</Trans></p>
					) : null}
					{days.map((day) => (
						<Card key={`${day.locationId}|${day.businessDate}|${day.currency}`} data-testid={`accounting-day-${day.businessDate}-${day.locationId}-${day.currency}`}>
							<CardHeader>
								<CardTitle className="flex flex-wrap items-center gap-2">
									{day.locationName} · {day.businessDate} · {day.currency}
									<Badge variant={day.status === 'final' ? 'success' : 'outline'}>
										{day.status === 'final' ? _(msg`Final`) : _(msg`Provisional`)}
									</Badge>
									{day.differenceMinor !== 0 ? (
										<Badge variant="destructive" data-testid={`accounting-difference-${day.businessDate}`}>
											<Trans>
												Out of balance by{' '}
												{money(Math.abs(day.differenceMinor), day.currency, i18n.locale)}
											</Trans>
										</Badge>
									) : (
										<Badge variant="success"><Trans>Balanced</Trans></Badge>
									)}
								</CardTitle>
							</CardHeader>
							<CardContent>
								<table className="w-full text-sm">
									<thead>
										<tr className="text-muted-foreground text-start">
											<th className="text-start font-medium"><Trans>Line</Trans></th>
											<th className="text-end font-medium"><Trans>Debit</Trans></th>
											<th className="text-end font-medium"><Trans>Credit</Trans></th>
										</tr>
									</thead>
									<tbody>
										{day.lines.map((line) => (
											<tr key={line.lineKey}>
												<td>{line.label}</td>
												<td className="text-end tabular-nums">
													{line.debitMinor ? money(line.debitMinor, day.currency, i18n.locale) : ''}
												</td>
												<td className="text-end tabular-nums">
													{line.creditMinor ? money(line.creditMinor, day.currency, i18n.locale) : ''}
												</td>
											</tr>
										))}
										<tr className="font-medium">
											<td><Trans>Total</Trans></td>
											<td className="text-end tabular-nums">{money(day.debitMinor, day.currency, i18n.locale)}</td>
											<td className="text-end tabular-nums">{money(day.creditMinor, day.currency, i18n.locale)}</td>
										</tr>
									</tbody>
								</table>
							</CardContent>
						</Card>
					))}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							onClick={() =>
								void exporter.submit({ intent: 'export', from, to, layout } as never, {
									method: 'post',
									encType: 'application/json',
								})
							}
							disabled={exporter.state !== 'idle' || days.length === 0}
							data-testid="accounting-export"
						>
							<Icon name="download" />
							<Trans>Export file</Trans>
						</Button>
						{done?.csv ? (
							<Button
								variant="outline"
								onClick={() => saveBlob(new Blob([done.csv!], { type: 'text/csv;charset=utf-8' }), done.filename ?? 'journal.csv')}
								data-testid="accounting-download"
							>
								<Trans>Download {done.filename}</Trans>
							</Button>
						) : null}
					</div>
					{done ? (
						<p role="status" className="text-sm" data-testid="accounting-export-result">
							<Trans>
								Exported {done.entries} entries. {done.adjustments} adjusting,{' '}
								{done.unchanged} unchanged since the last export, {done.provisional} provisional.
							</Trans>
						</p>
					) : null}
				</div>
			) : null}

			{lines.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle><Trans>Accounts</Trans></CardTitle>
						<CardDescription>
							<Trans>
								Name the account each line goes to, once. A line with no name
								uses a default account name.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{lines.map((line) => (
							<div key={line.lineKey} className="grid gap-2 sm:grid-cols-[1fr_8rem_1fr] sm:items-center">
								<span className="text-sm">{line.label}</span>
								<Input
									aria-label={_(msg`Account code for ${line.label}`)}
									placeholder={_(msg`Code`)}
									value={mapping[line.lineKey]?.code ?? ''}
									onChange={(event) =>
										setMapping({
											...mapping,
											[line.lineKey]: { code: event.target.value, name: mapping[line.lineKey]?.name ?? '' },
										})
									}
									data-testid={`accounting-code-${line.lineKey}`}
								/>
								<Input
									aria-label={_(msg`Account name for ${line.label}`)}
									placeholder={line.defaultName}
									value={mapping[line.lineKey]?.name ?? ''}
									onChange={(event) =>
										setMapping({
											...mapping,
											[line.lineKey]: { code: mapping[line.lineKey]?.code ?? '', name: event.target.value },
										})
									}
									data-testid={`accounting-name-${line.lineKey}`}
								/>
							</div>
						))}
						<Button
							className="self-start"
							disabled={mappingFetcher.state !== 'idle'}
							onClick={() =>
								void mappingFetcher.submit(
									{
										intent: 'save-mapping',
										rows: lines.map((line) => ({
											lineKey: line.lineKey,
											accountCode: mapping[line.lineKey]?.code ?? '',
											accountName: mapping[line.lineKey]?.name ?? '',
										})),
									} as never,
									{ method: 'post', encType: 'application/json' },
								)
							}
							data-testid="accounting-save-mapping"
						>
							<Trans>Save accounts</Trans>
						</Button>
						{mappingFetcher.state === 'idle' && mappingFetcher.data?.ok ? (
							<p role="status" className="text-muted-foreground text-sm"><Trans>Saved.</Trans></p>
						) : null}
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle><Trans>Weekly email to your bookkeeper</Trans></CardTitle>
					<CardDescription>
						<Trans>
							Every Monday, last week&apos;s journal as a table with a link to the
							file. The address is only used for this email.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<TextField
						label={_(msg`Bookkeeper email`)}
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						error={settingsFetcher.data?.ok === false ? _(msg`Enter a valid email address.`) : null}
						data-testid="accounting-bookkeeper"
					/>
					<label className="flex items-center gap-2 text-sm">
						<Checkbox
							checked={weekly}
							onCheckedChange={(next) => setWeekly(next === true)}
							data-testid="accounting-weekly"
						/>
						<Trans>Send it every Monday</Trans>
					</label>
					<Button
						className="self-start"
						disabled={settingsFetcher.state !== 'idle'}
						onClick={() =>
							void settingsFetcher.submit(
								{ intent: 'save-settings', layout, bookkeeperEmail: email.trim(), weeklyEmail: weekly } as never,
								{ method: 'post', encType: 'application/json' },
							)
						}
						data-testid="accounting-save-settings"
					>
						<Trans>Save</Trans>
					</Button>
				</CardContent>
			</Card>
		</WorkspacePage>
	)
}
