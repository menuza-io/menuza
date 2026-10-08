import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useId, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import {
	type ActionResult,
	action,
	loader,
	type QuarantineWarning,
} from './phone-numbers.server.ts'

export { action, loader }

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>
type PlatformNumber = LoaderData['numbers'][number]

function ResultMessage({ result }: { result: ActionResult | undefined }) {
	if (!result || result.ok) return null
	return (
		<p role="alert" className="text-destructive text-sm">
			{result.error}
		</p>
	)
}

function AddNumberForm() {
	const fetcher = useFetcher<ActionResult>()
	const formRef = useRef<HTMLFormElement>(null)
	const result = fetcher.data
	const fieldErrors = result && !result.ok ? result.fieldErrors : undefined

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) formRef.current?.reset()
	}, [fetcher.state, result])

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Add a number</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Add numbers bought in Twilio and routed to the LiveKit SIP trunk.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form
					ref={formRef}
					method="POST"
					className="flex flex-wrap items-end gap-4"
				>
					<input type="hidden" name="_action" value="add" />
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="platform-number-e164">
							<Trans>Phone number</Trans>
						</Label>
						<Input
							id="platform-number-e164"
							name="e164"
							type="tel"
							inputMode="tel"
							autoComplete="off"
							placeholder="+15551234567"
							required
							aria-invalid={fieldErrors?.e164 ? true : undefined}
						/>
						{fieldErrors?.e164 ? (
							<p className="text-destructive text-xs">{fieldErrors.e164}</p>
						) : null}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="platform-number-label">
							<Trans>Label (optional)</Trans>
						</Label>
						<Input
							id="platform-number-label"
							name="label"
							autoComplete="off"
							maxLength={80}
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Add number</Trans>
					</Button>
				</fetcher.Form>
				<div className="mt-3">
					<ResultMessage result={result} />
				</div>
			</CardContent>
		</Card>
	)
}

function NumberStatus({ number }: { number: PlatformNumber }) {
	const { i18n } = useLingui()
	if (number.retiredAt) {
		return (
			<Badge variant="outline">
				<Trans>Retired</Trans>
			</Badge>
		)
	}
	if (!number.organization?.id) {
		if (number.hold) {
			const until = number.hold.until
				? i18n.date(new Date(number.hold.until), { dateStyle: 'medium' })
				: null
			return (
				<div className="flex flex-col items-start gap-1">
					<Badge variant="outline">
						<Trans>Recently released</Trans>
					</Badge>
					<span className="text-muted-foreground text-xs">
						{until ? (
							<Trans>Held for the previous organization until {until}</Trans>
						) : (
							<Trans>
								Held: the previous organization was deleted while it had this
								number
							</Trans>
						)}
					</span>
				</div>
			)
		}
		return (
			<Badge variant="secondary">
				<Trans>Available</Trans>
			</Badge>
		)
	}
	if (!number.agentNumber?.id) {
		return (
			<Badge variant="secondary">
				<Trans>Assigned, not connected</Trans>
			</Badge>
		)
	}
	return number.agentNumber.isActive ? (
		<Badge>
			<Trans>Answering</Trans>
		</Badge>
	) : (
		<Badge variant="outline">
			<Trans>Awaiting line verification</Trans>
		</Badge>
	)
}

function QuarantineNotice({
	quarantine,
	checkboxId,
}: {
	quarantine: QuarantineWarning
	checkboxId: string
}) {
	const { i18n } = useLingui()
	const previous = quarantine.previousOrganization
	const releasedOn = quarantine.releasedAt
		? i18n.date(new Date(quarantine.releasedAt), { dateStyle: 'medium' })
		: null
	const previousName = previous?.name ?? ''
	return (
		<div
			role="alert"
			className="border-destructive text-destructive flex max-w-md flex-col gap-2 rounded-md border p-3 text-start text-sm"
		>
			<p>
				{previous && releasedOn ? (
					<Trans>
						This number was released by {previousName} on {releasedOn}.
					</Trans>
				) : releasedOn ? (
					<Trans>
						This number was released on {releasedOn} by an organization that no
						longer exists.
					</Trans>
				) : (
					<Trans>
						This number belonged to an organization that was deleted.
					</Trans>
				)}{' '}
				{quarantine.hadVerifiedForwarding ? (
					<Trans>
						That organization had verified call forwarding to this number. Its
						callers will very likely reach the new organization's agent until it
						turns forwarding off at its carrier.
					</Trans>
				) : (
					<Trans>
						The previous organization may still forward its line to this number,
						so its callers could reach the new organization's agent.
					</Trans>
				)}
			</p>
			<div className="flex items-center gap-2">
				<Checkbox id={checkboxId} name="confirmReassign" value="on" />
				<Label htmlFor={checkboxId}>
					<Trans>Reassign anyway</Trans>
				</Label>
			</div>
		</div>
	)
}

function NumberActions({ number }: { number: PlatformNumber }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<ActionResult>()
	const [organization, setOrganization] = useState('')
	const checkboxId = useId()
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const quarantine = result && !result.ok ? result.quarantine : undefined
	const e164 = number.e164
	const submit = (action: 'unassign' | 'retire') =>
		void fetcher.submit({ _action: action, id: number.id }, { method: 'POST' })

	if (number.retiredAt) return null
	return (
		<div className="flex flex-col items-end gap-2">
			<div className="flex flex-wrap items-center justify-end gap-2">
				{number.organization?.id ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending}
						onClick={() => {
							if (
								window.confirm(
									_(
										msg`Unassign ${e164}? The organization's agent stops answering it right away.`,
									),
								)
							)
								submit('unassign')
						}}
					>
						<Trans>Unassign</Trans>
					</Button>
				) : (
					<fetcher.Form method="POST" className="flex flex-col items-end gap-2">
						<input type="hidden" name="_action" value="assign" />
						<input type="hidden" name="id" value={number.id} />
						<div className="flex items-center gap-2">
							<Input
								name="organization"
								value={organization}
								onChange={(event) => setOrganization(event.target.value)}
								placeholder={_(msg`Organization slug or ID`)}
								aria-label={_(msg`Organization slug or ID for ${e164}`)}
								className="h-8 w-48"
								required
							/>
							<Button type="submit" size="sm" disabled={pending}>
								<Trans>Assign</Trans>
							</Button>
						</div>
						{quarantine ? (
							<QuarantineNotice
								quarantine={quarantine}
								checkboxId={checkboxId}
							/>
						) : null}
					</fetcher.Form>
				)}
				<Button
					type="button"
					variant="destructive"
					size="sm"
					disabled={pending}
					onClick={() => {
						if (
							window.confirm(
								_(
									msg`Retire ${e164}? It can't be assigned again, and any agent using it stops answering.`,
								),
							)
						)
							submit('retire')
					}}
				>
					<Trans>Retire</Trans>
				</Button>
			</div>
			{quarantine ? null : <ResultMessage result={result} />}
		</div>
	)
}

export default function AdminPhoneNumbersPage() {
	const { numbers } = useLoaderData<typeof loader>()

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-3xl font-bold tracking-tight">
					<Trans>Phone numbers</Trans>
				</h1>
				<p className="text-muted-foreground">
					<Trans>
						Platform-owned numbers for the AI phone agent. Organizations can
						only connect numbers assigned to them here.
					</Trans>
				</p>
			</div>

			<AddNumberForm />

			{numbers.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No numbers in the inventory yet.</Trans>
				</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Number</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							<TableHead>
								<Trans>Organization</Trans>
							</TableHead>
							<TableHead className="text-end">
								<Trans>Actions</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{numbers.map((number) => (
							<TableRow key={number.id}>
								<TableCell>
									<div className="font-medium tabular-nums" dir="ltr">
										{number.e164}
									</div>
									{number.label ? (
										<div className="text-muted-foreground text-sm">
											{number.label}
										</div>
									) : null}
								</TableCell>
								<TableCell>
									<NumberStatus number={number} />
								</TableCell>
								<TableCell>
									{number.organization?.id ? (
										<div>
											<div>{number.organization.name}</div>
											<div className="text-muted-foreground text-sm">
												{number.organization.slug}
											</div>
										</div>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</TableCell>
								<TableCell className="text-end">
									<NumberActions number={number} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	)
}
