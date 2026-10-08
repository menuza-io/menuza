import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PhoneNumberMode } from '@repo/phone-agent'
import { AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import {
	type listAssignablePlatformNumbers,
	type listPhoneNumbers,
} from '#app/utils/phone-agent/phone-agent.server.ts'
import {
	FieldErrorText,
	type SettingsSaveResult,
	useSettingsErrorText,
	useSettingsFieldErrors,
} from './settings-page.tsx'
import { useVerticalLabels } from './vertical-labels.ts'

// These components post to the action of the route that renders them, which
// is the phone agent Setup page (`add-number`, `send-line-code`, ...).

export type PhoneNumber = Awaited<ReturnType<typeof listPhoneNumbers>>[number]
export type AssignableNumber = Awaited<
	ReturnType<typeof listAssignablePlatformNumbers>
>[number]
/** Something a number answers for, from the server vertical's `listScopes`. */
export type NumberScope = { id: string; name: string; isDefault: boolean }

const MODE_LABELS: Record<PhoneNumberMode, MessageDescriptor> = {
	forwarding: msg`Forwarding`,
	dedicated: msg`Dedicated`,
}

function ResultError({ error }: { error: string | undefined }) {
	const describe = useSettingsErrorText()
	const text = describe(error)
	if (!text) return null
	return (
		<p role="alert" className="text-destructive text-sm">
			{text}
		</p>
	)
}

export function PhoneNumbersSection({
	numbers,
	assignableNumbers,
	scopes,
	canUpdate,
}: {
	numbers: PhoneNumber[]
	assignableNumbers: AssignableNumber[]
	scopes: NumberScope[]
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const labels = useVerticalLabels()
	const scopeMissing = Boolean(labels.scope) && scopes.length === 0
	const [adding, setAdding] = useState(false)
	const [removing, setRemoving] = useState<PhoneNumber | null>(null)
	const [verifying, setVerifying] = useState<PhoneNumber | null>(null)
	const scopeName = new Map(scopes.map((scope) => [scope.id, scope.name]))

	return (
		<AnnotatedSection
			title={<Trans>Phone numbers</Trans>}
			description={
				<Trans>
					Numbers the agent answers. We assign agent numbers to your business;
					forwarded lines start answering once you verify them.
				</Trans>
			}
		>
			<Card>
				<CardContent className="flex flex-col gap-4">
					{numbers.length === 0 ? (
						// The add-number notes below already explain the empty state.
						canUpdate &&
						(scopeMissing || assignableNumbers.length === 0) ? null : (
							<p className="text-muted-foreground text-sm">
								<Trans>No numbers connected yet.</Trans>
							</p>
						)
					) : (
						<ul className="divide-y rounded-lg border">
							{numbers.map((number) => {
								const mode =
									number.mode === 'dedicated' ? 'dedicated' : 'forwarding'
								const forwardedFrom = number.forwardedFrom
								const needsVerification =
									mode === 'forwarding' && !number.verifiedAt
								return (
									<li
										key={number.id}
										className="flex flex-wrap items-center gap-3 p-4"
									>
										<Icon name="phone" className="text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium tabular-nums" dir="ltr">
													{number.e164}
												</span>
												<Badge variant="secondary">
													{_(MODE_LABELS[mode])}
												</Badge>
												{needsVerification ? (
													<Badge variant="outline">
														<Trans>Not answering: verify line</Trans>
													</Badge>
												) : !number.isActive ? (
													<Badge variant="outline">
														<Trans>Paused</Trans>
													</Badge>
												) : null}
											</div>
											<p className="text-muted-foreground text-sm">
												{labels.scope
													? number.scopeId
														? (scopeName.get(number.scopeId) ??
															labels.scope.unknown)
														: labels.scope.all
													: null}
												{forwardedFrom ? (
													<>
														{labels.scope ? ' · ' : null}
														<Trans>
															Forwarded from{' '}
															<span dir="ltr" className="tabular-nums">
																{forwardedFrom}
															</span>
														</Trans>
													</>
												) : null}
											</p>
										</div>
										{canUpdate && needsVerification ? (
											<Button
												type="button"
												size="sm"
												onClick={() => setVerifying(number)}
											>
												<Icon name="shield-check" />
												<Trans>Verify line</Trans>
											</Button>
										) : null}
										{canUpdate ? (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => setRemoving(number)}
											>
												<Icon name="trash-2" />
												<Trans>Remove</Trans>
											</Button>
										) : null}
									</li>
								)
							})}
						</ul>
					)}
					{canUpdate ? (
						scopeMissing ? (
							<p className="text-muted-foreground text-sm">
								{labels.scope?.missing}
							</p>
						) : assignableNumbers.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{numbers.length === 0 ? (
									<Trans>
										No agent numbers are assigned to your business yet. Contact
										support to get one.
									</Trans>
								) : (
									<Trans>
										All numbers assigned to your business are in use. Contact
										support to get another.
									</Trans>
								)}
							</p>
						) : (
							<div>
								<Button
									type="button"
									variant="outline"
									onClick={() => setAdding(true)}
								>
									<Icon name="plus" />
									<Trans>Add number</Trans>
								</Button>
							</div>
						)
					) : null}
				</CardContent>
			</Card>

			{adding ? (
				<AddNumberDialog
					scopes={scopes}
					assignableNumbers={assignableNumbers}
					onClose={() => setAdding(false)}
				/>
			) : null}
			{verifying ? (
				<VerifyLineDialog
					number={verifying}
					onClose={() => setVerifying(null)}
				/>
			) : null}
			{removing ? (
				<RemoveNumberDialog
					number={removing}
					onClose={() => setRemoving(null)}
				/>
			) : null}
		</AnnotatedSection>
	)
}

export function AddNumberDialog({
	scopes,
	assignableNumbers,
	onClose,
}: {
	scopes: NumberScope[]
	assignableNumbers: AssignableNumber[]
	onClose(): void
}) {
	const { _ } = useLingui()
	const labels = useVerticalLabels()
	const fetcher = useFetcher<SettingsSaveResult>()
	const [scopeId, setScopeId] = useState(
		(scopes.find((scope) => scope.isDefault) ?? scopes[0])?.id ?? '',
	)
	const [platformNumberId, setPlatformNumberId] = useState(
		assignableNumbers[0]?.id ?? '',
	)
	const [mode, setMode] = useState<PhoneNumberMode>('forwarding')
	const [forwardedFrom, setForwardedFrom] = useState('')
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const fieldErrors = useSettingsFieldErrors(
		result && !result.ok ? result.fieldErrors : undefined,
	)

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add phone number</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose one of the agent numbers assigned to your business.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault()
						void fetcher.submit(
							{
								intent: 'add-number',
								number: {
									scopeId: labels.scope ? scopeId : null,
									platformNumberId,
									mode,
									forwardedFrom:
										mode === 'forwarding' && forwardedFrom.trim()
											? forwardedFrom.trim()
											: null,
								},
							},
							{ method: 'POST', encType: 'application/json' },
						)
					}}
				>
					{labels.scope ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-number-scope">{labels.scope.label}</Label>
							<Select
								value={scopeId}
								items={scopes.map((scope) => ({
									value: scope.id,
									label: scope.name,
								}))}
								onValueChange={(value) => {
									if (typeof value === 'string') setScopeId(value)
								}}
							>
								<SelectTrigger id="phone-number-scope" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{scopes.map((scope) => (
										<SelectItem key={scope.id} value={scope.id}>
											{scope.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FieldErrorText error={fieldErrors.scopeId} />
						</div>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="phone-number-platform">
							<Trans>Agent phone number</Trans>
						</Label>
						<Select
							value={platformNumberId}
							items={assignableNumbers.map((number) => ({
								value: number.id,
								label: number.label
									? `${number.e164} · ${number.label}`
									: number.e164,
							}))}
							onValueChange={(value) => {
								if (typeof value === 'string') setPlatformNumberId(value)
							}}
						>
							<SelectTrigger id="phone-number-platform" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{assignableNumbers.map((number) => (
									<SelectItem key={number.id} value={number.id}>
										<span dir="ltr" className="tabular-nums">
											{number.e164}
										</span>
										{number.label ? ` · ${number.label}` : null}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<FieldErrorText error={fieldErrors.platformNumberId} />
					</div>

					<fieldset className="flex flex-col gap-2">
						<legend className="mb-1 text-sm font-medium">
							<Trans>How calls reach the agent</Trans>
						</legend>
						<RadioGroup
							value={mode}
							onValueChange={(value: string) =>
								setMode(value === 'dedicated' ? 'dedicated' : 'forwarding')
							}
							className="grid gap-2"
						>
							<label className="flex items-start gap-2 text-sm">
								<RadioGroupItem value="forwarding" className="mt-0.5" />
								<span>
									<span className="font-medium">
										{_(MODE_LABELS.forwarding)}
									</span>
									<span className="text-muted-foreground block text-xs">
										<Trans>Your existing line forwards to this number.</Trans>
									</span>
								</span>
							</label>
							<label className="flex items-start gap-2 text-sm">
								<RadioGroupItem value="dedicated" className="mt-0.5" />
								<span>
									<span className="font-medium">
										{_(MODE_LABELS.dedicated)}
									</span>
									<span className="text-muted-foreground block text-xs">
										<Trans>A new number only the agent answers.</Trans>
									</span>
								</span>
							</label>
						</RadioGroup>
					</fieldset>

					{mode === 'forwarding' ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-number-forwarded-from">
								<Trans>Your business line</Trans>
							</Label>
							<Input
								id="phone-number-forwarded-from"
								type="tel"
								inputMode="tel"
								autoComplete="off"
								placeholder="+15551234567"
								value={forwardedFrom}
								required
								aria-invalid={fieldErrors.forwardedFrom ? true : undefined}
								aria-describedby="phone-number-forwarded-hint"
								onChange={(event) => setForwardedFrom(event.target.value)}
							/>
							<p
								id="phone-number-forwarded-hint"
								className="text-muted-foreground text-xs"
							>
								<Trans>
									The number customers dial today, in international format.
									You'll verify it with a code before the agent answers.
								</Trans>
							</p>
							<FieldErrorText error={fieldErrors.forwardedFrom} />
						</div>
					) : null}

					<ResultError
						error={result && !result.ok ? result.error : undefined}
					/>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={
								pending ||
								!platformNumberId ||
								(Boolean(labels.scope) && !scopeId) ||
								(mode === 'forwarding' && !forwardedFrom.trim())
							}
						>
							<Trans>Add number</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export function VerifyLineDialog({
	number,
	onClose,
}: {
	number: PhoneNumber
	onClose(): void
}) {
	const { _ } = useLingui()
	const describe = useSettingsErrorText()
	const sendFetcher = useFetcher<SettingsSaveResult>()
	const verifyFetcher = useFetcher<SettingsSaveResult>()
	const [method, setMethod] = useState<'sms' | 'call'>('sms')
	const [code, setCode] = useState('')
	const line = number.forwardedFrom ?? ''
	const sendResult = sendFetcher.data
	const verifyResult = verifyFetcher.data
	const codeSent =
		Boolean(sendResult?.ok) ||
		Boolean(
			number.verificationExpiresAt &&
			new Date(number.verificationExpiresAt).getTime() > Date.now(),
		)
	const codeError = describe(
		verifyResult && !verifyResult.ok
			? verifyResult.fieldErrors?.code
			: undefined,
	)

	useEffect(() => {
		if (verifyFetcher.state === 'idle' && verifyResult?.ok) onClose()
	}, [verifyFetcher.state, verifyResult, onClose])

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Verify your business line</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							We'll send a 6-digit code to{' '}
							<span dir="ltr" className="tabular-nums">
								{line}
							</span>
							. The agent starts answering once you enter it.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-medium">
						<Trans>How to send the code</Trans>
					</legend>
					<RadioGroup
						value={method}
						onValueChange={(value: string) =>
							setMethod(value === 'call' ? 'call' : 'sms')
						}
						className="grid gap-2"
					>
						<label className="flex items-center gap-2 text-sm">
							<RadioGroupItem value="sms" />
							<Trans>Text message</Trans>
						</label>
						<label className="flex items-center gap-2 text-sm">
							<RadioGroupItem value="call" />
							<Trans>Phone call (for landlines)</Trans>
						</label>
					</RadioGroup>
				</fieldset>
				<div>
					<Button
						type="button"
						variant="outline"
						disabled={sendFetcher.state !== 'idle'}
						onClick={() =>
							void sendFetcher.submit(
								{ intent: 'send-line-code', id: number.id, method },
								{ method: 'POST', encType: 'application/json' },
							)
						}
					>
						<Icon name="send" />
						{codeSent ? (
							<Trans>Send a new code</Trans>
						) : (
							<Trans>Send code</Trans>
						)}
					</Button>
				</div>
				<ResultError
					error={sendResult && !sendResult.ok ? sendResult.error : undefined}
				/>
				{sendResult?.ok ? (
					<p role="status" className="text-muted-foreground text-sm">
						<Trans>Code sent. It expires in 10 minutes.</Trans>
					</p>
				) : null}

				{codeSent ? (
					<form
						className="flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault()
							void verifyFetcher.submit(
								{
									intent: 'verify-line-code',
									id: number.id,
									code: code.trim(),
								},
								{ method: 'POST', encType: 'application/json' },
							)
						}}
					>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="phone-line-code">
								<Trans>Verification code</Trans>
							</Label>
							<Input
								id="phone-line-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								pattern="[0-9]{6}"
								maxLength={6}
								value={code}
								required
								autoFocus
								aria-label={_(msg`6-digit verification code`)}
								aria-invalid={codeError ? true : undefined}
								onChange={(event) =>
									setCode(event.target.value.replace(/\D/g, ''))
								}
							/>
							<FieldErrorText error={codeError} />
						</div>
						<ResultError
							error={
								verifyResult && !verifyResult.ok
									? verifyResult.error
									: undefined
							}
						/>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={onClose}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="submit"
								disabled={verifyFetcher.state !== 'idle' || code.length !== 6}
							>
								<Trans>Verify</Trans>
							</Button>
						</DialogFooter>
					</form>
				) : (
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	)
}

export function RemoveNumberDialog({
	number,
	onClose,
}: {
	number: PhoneNumber
	onClose(): void
}) {
	const fetcher = useFetcher<SettingsSaveResult>()
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const e164 = number.e164

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Remove {e164}?</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							The agent stops answering this number. Update your call forwarding
							or SIP routing so callers still reach you.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<ResultError error={result && !result.ok ? result.error : undefined} />
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() =>
							void fetcher.submit(
								{ intent: 'remove-number', id: number.id },
								{ method: 'POST', encType: 'application/json' },
							)
						}
					>
						<Trans>Remove number</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
