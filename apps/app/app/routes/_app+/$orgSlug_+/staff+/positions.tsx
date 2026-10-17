import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { PositionDot, type PositionColorKey } from '@repo/ui/position-color'
import { Skeleton } from '@repo/ui/skeleton'
import { useState, type FormEvent } from 'react'
import { useLoaderData } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { PageWithBack } from '#app/components/staff/page-back.tsx'
import { PositionColorField } from '#app/components/staff/position-color-field.tsx'
import { PayCell } from '#app/components/staff/staff-roster.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_SECTION_REQUIREMENTS } from '#app/utils/staffing/sections.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	minorToInput,
	parseMoneyToMinor,
} from '#app/utils/staffing/staff-format.ts'
import {
	positionsSchema,
	type StaffPositionRow,
} from '#app/utils/staffing/staff-types.ts'
import {
	hasErrors,
	validatePositionForm,
} from '#app/utils/staffing/staff-validation.ts'
import { loadStaffScopes } from '#app/utils/staffing/team-context.server.ts'
import { type Route } from './+types/positions.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireStaffingAccess(
		request,
		params.orgSlug,
		STAFF_SECTION_REQUIREMENTS.team,
	)
	const scopes = await loadStaffScopes(access.organizationId)
	return {
		orgSlug: params.orgSlug,
		currencies: [...new Set(scopes.map((scope) => scope.currency))],
	}
}

export default function StaffPositionsRoute() {
	const { orgSlug, currencies } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const { client, can, ready } = useStaffClient('staff')
	const canWrite = can(P.UPDATE_STAFF)
	const canSeePay = can(P.READ_STAFF_PAY)
	const [showArchived, setShowArchived] = useState(false)
	const [editing, setEditing] = useState<StaffPositionRow | 'new' | null>(null)
	const query = useStaffQuery(
		client,
		ready ? `/positions${showArchived ? '?includeArchived=1' : ''}` : null,
		positionsSchema,
	)
	const archive = useStaffAction()
	const positions = query.data?.positions ?? []

	async function setArchived(position: StaffPositionRow, archived: boolean) {
		const positionName = position.name
		const result = await archive.run(() =>
			client.request(`/positions/${position.id}`, {
				method: 'PATCH',
				json: { archived },
			}),
		)
		if (result.ok) {
			toast.success(
				archived
					? _(t`${positionName} archived.`)
					: _(t`${positionName} restored.`),
			)
			query.reload()
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<PageWithBack to={`/${orgSlug}/staff/team`} label={_(t`Team`)}>
				<PageHeader
					title={_(t`Positions`)}
					description={_(
						t`The jobs people do here. Assign them from a person's profile.`,
					)}
					actions={
						<>
							{canWrite ? (
								<Button onClick={() => setEditing('new')}>
									<Icon name="plus" />
									<Trans>Add position</Trans>
								</Button>
							) : null}
						</>
					}
				/>
			</PageWithBack>

			<Label className="flex min-h-11 w-fit items-center gap-3 text-sm md:min-h-0">
				<Checkbox
					checked={showArchived}
					onCheckedChange={(checked) => setShowArchived(checked)}
				/>
				<Trans>Show archived</Trans>
			</Label>

			{archive.error ? (
				<Alert variant="destructive">
					<AlertDescription>{archive.error}</AlertDescription>
				</Alert>
			) : null}

			{!ready || query.loading ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading positions</Trans>
					</span>
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : query.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeStaffError(query.error, _)}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={query.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : positions.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>No positions yet</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Positions such as Server or Line cook let you say what each
								person does and where.
							</Trans>
						</>
					}
					icons={['users', 'user-plus', 'clock']}
				>
					{canWrite ? (
						<>
							<Button onClick={() => setEditing('new')}>
								<Icon name="plus" />
								<Trans>Add position</Trans>
							</Button>
						</>
					) : null}
				</EmptyState>
			) : (
				<ItemGroup>
					{positions.map((position) => (
						<Item key={position.id} variant="outline" render={<li />}>
							<ItemContent>
								<ItemTitle
									className={
										position.archivedAt ? 'text-muted-foreground' : undefined
									}
								>
									<PositionDot
										colorKey={position.colorKey as PositionColorKey}
									/>
									{position.name}
									{position.archivedAt ? (
										<span className="text-xs font-normal">
											<Trans>Archived</Trans>
										</span>
									) : null}
								</ItemTitle>
								<ItemDescription>
									{[position.area, position.tipEligible ? _(t`Tips`) : null]
										.filter(Boolean)
										.join(' · ')}
								</ItemDescription>
							</ItemContent>
							<ItemActions>
								{canSeePay ? (
									<span className="me-2 text-sm tabular-nums">
										{position.defaultRateMinor != null && position.currency ? (
											<PayCell
												rate={{
													payType: 'hourly',
													rateMinor: position.defaultRateMinor,
													annualSalaryMinor: null,
													currency: position.currency,
												}}
												locale={i18n.locale}
											/>
										) : (
											<span className="text-muted-foreground">–</span>
										)}
									</span>
								) : null}
								{canWrite ? (
									<>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setEditing(position)}
										>
											<Trans>Edit</Trans>
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={archive.pending}
											onClick={() =>
												void setArchived(position, !position.archivedAt)
											}
										>
											{position.archivedAt ? (
												<Trans>Restore</Trans>
											) : (
												<Trans>Archive</Trans>
											)}
										</Button>
									</>
								) : null}
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}

			{editing ? (
				<PositionDialog
					key={editing === 'new' ? 'new' : editing.id}
					position={editing === 'new' ? null : editing}
					currencies={currencies}
					canSetRate={can(P.UPDATE_STAFF_PAY)}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null)
						query.reload()
					}}
				/>
			) : null}
		</div>
	)
}

function PositionDialog({
	position,
	currencies,
	canSetRate,
	onClose,
	onSaved,
}: {
	position: StaffPositionRow | null
	currencies: Array<'USD' | 'CAD' | 'SAR'>
	canSetRate: boolean
	onClose: () => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('staff')
	const action = useStaffAction()
	const [name, setName] = useState(position?.name ?? '')
	const [area, setArea] = useState(position?.area ?? '')
	const [colorKey, setColorKey] = useState<PositionColorKey>(
		(position?.colorKey as PositionColorKey | undefined) ?? 'neutral',
	)
	const [tipEligible, setTipEligible] = useState(position?.tipEligible ?? false)
	const [rate, setRate] = useState(minorToInput(position?.defaultRateMinor))
	const [currency, setCurrency] = useState<string>(
		position?.currency ?? currencies[0] ?? 'USD',
	)
	// After the first Save, errors follow the values, so each one clears as
	// soon as its field is valid.
	const [submitted, setSubmitted] = useState(false)
	const validate = () => validatePositionForm({ name, rate }, _, { canSetRate })
	const errors = submitted ? validate() : {}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setSubmitted(true)
		if (hasErrors(validate())) return
		let defaultRateMinor: number | null | undefined
		if (canSetRate) {
			defaultRateMinor = rate.trim() === '' ? null : parseMoneyToMinor(rate)
		}
		const body = {
			name: name.trim(),
			area: area.trim() || null,
			colorKey,
			tipEligible,
			...(defaultRateMinor !== undefined
				? {
						defaultRateMinor,
						currency: defaultRateMinor === null ? null : currency,
					}
				: {}),
		}
		const result = await action.run(() =>
			position
				? client.request(`/positions/${position.id}`, {
						method: 'PATCH',
						json: body,
					})
				: client.request('/positions', {
						method: 'POST',
						json: {
							...body,
							area: body.area ?? undefined,
							defaultRateMinor: body.defaultRateMinor ?? undefined,
							currency: body.currency ?? undefined,
						},
					}),
		)
		if (result.ok) {
			toast.success(position ? _(t`Position saved.`) : _(t`Position added.`))
			onSaved()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex flex-col gap-4"
				>
					<DialogHeader>
						<DialogTitle>
							{position ? (
								<Trans>Edit position</Trans>
							) : (
								<Trans>Add position</Trans>
							)}
						</DialogTitle>
						<DialogDescription>
							<Trans>
								A name and a color are enough. The rest is optional.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<TextField
						label={<Trans>Name</Trans>}
						value={name}
						onChange={(event) => setName(event.target.value)}
						error={errors.name}
						maxLength={60}
						autoFocus
					/>
					<TextField
						label={<Trans>Area</Trans>}
						optional
						value={area}
						onChange={(event) => setArea(event.target.value)}
						placeholder={_(t`Front of house, Warehouse…`)}
						maxLength={60}
					/>
					<PositionColorField
						legend={_(t`Color`)}
						value={colorKey}
						onChange={setColorKey}
					/>
					<SwitchField
						label={<Trans>Receives tips</Trans>}
						description={<Trans>Included when tips are divided.</Trans>}
						checked={tipEligible}
						onCheckedChange={setTipEligible}
					/>
					{canSetRate ? (
						<div
							className={
								currencies.length > 1
									? 'grid gap-4 sm:grid-cols-2'
									: 'grid gap-4'
							}
						>
							<TextField
								label={<Trans>Default hourly rate</Trans>}
								optional
								inputMode="decimal"
								dir="ltr"
								value={rate}
								onChange={(event) => setRate(event.target.value)}
								error={errors.rate}
							/>
							{currencies.length > 1 ? (
								<SelectField
									label={<Trans>Currency</Trans>}
									value={currency}
									onValueChange={setCurrency}
									options={currencies.map((code) => ({
										value: code,
										label: code,
									}))}
								/>
							) : null}
						</div>
					) : null}
					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={action.pending}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={action.pending}>
							{action.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
