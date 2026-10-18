import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useId } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { action, loader } from './feature-flags_.reservations-fees.server.ts'
import {
	formatBpAsPercent,
	type FeeActionResult,
} from './feature-flags_.reservations-fees.shared.ts'

export { action, loader }

function FieldError({ message }: { message?: string }) {
	return message ? (
		<p role="alert" className="text-destructive text-xs">
			{message}
		</p>
	) : null
}

function SystemFeeForm({ systemBp }: { systemBp: number | null }) {
	const fetcher = useFetcher<FeeActionResult>()
	const { _ } = useLingui()
	const id = useId()
	const errors =
		fetcher.data && !fetcher.data.ok ? fetcher.data.fieldErrors : undefined
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>System default</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Applies to every organization without its own override. Basis
						points: 100 is 1.00%.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-2xl font-semibold" data-testid="system-fee">
					{systemBp === null ? _(msg`Not set`) : formatBpAsPercent(systemBp)}
				</p>
				<fetcher.Form method="POST" className="flex flex-wrap items-end gap-4">
					<input type="hidden" name="_action" value="set-system" />
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-bp`}>
							<Trans>Basis points</Trans>
						</Label>
						<Input
							id={`${id}-bp`}
							name="bp"
							inputMode="numeric"
							autoComplete="off"
							defaultValue={systemBp ?? ''}
							aria-invalid={errors?.bp ? true : undefined}
						/>
						<FieldError
							message={
								errors?.bp &&
								_(msg`Enter a whole number of basis points from 0 to 10000.`)
							}
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Save default</Trans>
					</Button>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}

function AddOverrideForm({
	organizations,
}: {
	organizations: { name: string; slug: string }[]
}) {
	const fetcher = useFetcher<FeeActionResult>()
	const { _ } = useLingui()
	const id = useId()
	const errors =
		fetcher.data && !fetcher.data.ok ? fetcher.data.fieldErrors : undefined
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Add or change an override</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Pick an organization by name or slug. Saving again replaces its
						override.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="POST" className="flex flex-wrap items-end gap-4">
					<input type="hidden" name="_action" value="set-override" />
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-org`}>
							<Trans>Organization</Trans>
						</Label>
						<Input
							id={`${id}-org`}
							name="organization"
							list={`${id}-orgs`}
							autoComplete="off"
							aria-invalid={errors?.organization ? true : undefined}
						/>
						<datalist id={`${id}-orgs`}>
							{organizations.map((org) => (
								<option key={org.slug} value={org.slug}>
									{org.name}
								</option>
							))}
						</datalist>
						<FieldError message={errors?.organization} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-bp`}>
							<Trans>Basis points</Trans>
						</Label>
						<Input
							id={`${id}-bp`}
							name="bp"
							inputMode="numeric"
							autoComplete="off"
							aria-invalid={errors?.bp ? true : undefined}
						/>
						<FieldError
							message={
								errors?.bp &&
								_(msg`Enter a whole number of basis points from 0 to 10000.`)
							}
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Save override</Trans>
					</Button>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}

export default function ReservationsFeesAdmin() {
	const { systemBp, overrides, organizations } = useLoaderData<typeof loader>()
	const removeFetcher = useFetcher<FeeActionResult>()
	const { _ } = useLingui()
	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Reservations platform fee</Trans>}
				description={
					<Trans>
						The share of each Reservations payment kept by the platform, in
						basis points.
					</Trans>
				}
			/>
			<SystemFeeForm systemBp={systemBp} />
			<AddOverrideForm organizations={organizations} />
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Organization overrides</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					{overrides.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No organization has its own fee.</Trans>
						</p>
					) : (
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Organization</Trans>
									</TableHead>
									<TableHead>
										<Trans>Fee</Trans>
									</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{overrides.map((row) => (
									<TableRow key={row.id}>
										<TableCell>{row.name}</TableCell>
										<TableCell>
											{row.bp === null
												? _(msg`Invalid`)
												: formatBpAsPercent(row.bp)}
										</TableCell>
										<TableCell>
											<removeFetcher.Form method="POST">
												<input
													type="hidden"
													name="_action"
													value="remove-override"
												/>
												<input type="hidden" name="id" value={row.id} />
												<Button type="submit" variant="outline" size="sm">
													<Trans>Remove</Trans>
												</Button>
											</removeFetcher.Form>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
