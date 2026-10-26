import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { Item, ItemMedia, ItemContent } from '@repo/ui/item'
import { useState } from 'react'
import { IDLE_LOCK_CHOICES } from '~/lib/activity.ts'
import { type PosSettings } from '~/lib/config.ts'
import {
	pairingHosts,
	parsePairingInput,
	serversProblem,
} from '~/lib/pairing.ts'
import { DEMO_PIN } from '~/lib/signin.ts'
import { type MenuLocation } from '~/lib/types.ts'
import {
	Input,
	Button,
	Checkbox,
	Modal,
	Reveal,
	cn,
	fieldClass,
	Select,
} from '~/ui/primitives.tsx'

export function SettingsSheet({
	open,
	onClose,
	settings,
	locations,
	lastSyncedAt,
	error,
	waitingOrders,
	onSave,
	onPair,
	onUnpair,
	required,
}: {
	open: boolean
	onClose: () => void
	settings: PosSettings
	locations: MenuLocation[]
	lastSyncedAt: number | null
	error: string | null
	/** Orders saved here that have not reached the server yet. */
	waitingOrders: number
	onSave: (patch: Partial<PosSettings>) => void | Promise<void>
	/** Resolves to an error message, or null when pairing worked. */
	onPair: (input: string) => Promise<string | null>
	onUnpair: () => void
	/** First run: there is nothing to go back to. */
	required?: boolean
}) {
	const { _, i18n } = useLingui()
	const [draft, setDraft] = useState(settings)
	const [pairingText, setPairingText] = useState('')
	const [pairingError, setPairingError] = useState<string | null>(null)
	const [pairing, setPairing] = useState(false)
	const [confirmUnpair, setConfirmUnpair] = useState(false)
	const [showManual, setShowManual] = useState(!required)
	const set = <K extends keyof PosSettings>(key: K, value: PosSettings[K]) =>
		setDraft((d) => ({ ...d, [key]: value }))
	const paired = settings.deviceToken !== null
	const pairedName = settings.deviceLabel ?? settings.terminalCode
	const terminalCode = settings.terminalCode
	const lastUpdated = lastSyncedAt
		? new Date(lastSyncedAt).toLocaleString(i18n.locale)
		: ''
	// Typed addresses follow the same rules as a pairing link: https, and trusted.
	const serverProblem = draft.demo
		? null
		: serversProblem([draft.appUrl.trim(), draft.tenantApiUrl.trim()])
	const valid =
		(draft.demo || (draft.appUrl.trim() && draft.slug.trim())) &&
		serverProblem === null
	/** Where a pasted link would point the till, shown before it is used. */
	const pastedLink = parsePairingInput(pairingText)
	const pastedHost = pastedLink ? pairingHosts(pastedLink).api : null
	/** Idle-lock choices, worded in the till's language. */
	const lockLabel = (seconds: number) =>
		seconds === 0
			? _(t`Never`)
			: seconds < 60
				? _(plural(seconds, { one: '# second', other: '# seconds' }))
				: _(plural(seconds / 60, { one: '# minute', other: '# minutes' }))

	const doPair = async () => {
		if (pairing || !pairingText.trim()) return
		setPairing(true)
		setPairingError(null)
		try {
			const problem = await onPair(pairingText)
			if (problem) setPairingError(problem)
			else {
				setPairingText('')
				onClose()
			}
		} catch {
			setPairingError(_(t`Could not pair this terminal. Try again.`))
		} finally {
			setPairing(false)
		}
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			dismissible={!required}
			title={required ? _(t`Set up this terminal`) : _(t`Terminal settings`)}
			footer={
				<Button
					variant="primary"
					size="lg"
					className="w-full"
					disabled={!valid}
					onClick={() => {
						void onSave({
							appUrl: draft.appUrl.trim().replace(/\/+$/, ''),
							slug: draft.slug.trim().toLowerCase(),
							tenantApiUrl: draft.tenantApiUrl.trim().replace(/\/+$/, ''),
							terminalCode: paired
								? settings.terminalCode
								: draft.terminalCode.trim().toUpperCase().slice(0, 6) || 'T1',
							locationId: draft.locationId,
							idleLockSeconds: draft.idleLockSeconds,
							demo: draft.demo,
							...(paired
								? {}
								: { signInRequired: draft.demo && draft.signInRequired }),
						})
						onClose()
					}}
				>
					{required ? <Trans>Load menu</Trans> : <Trans>Save</Trans>}
				</Button>
			}
		>
			<form
				className="space-y-6 p-4 sm:p-5"
				onSubmit={(e) => e.preventDefault()}
			>
				<Field
					label={_(t`Language`)}
					hint={_(t`For this device only. Saved at once.`)}
				>
					<span className="relative block">
						<Icon
							name="languages"
							className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 z-10 size-5 -translate-y-1/2"
						/>
						<Select
							// The language in use now: chosen here, or the restaurant's default.
							value={i18n.locale === 'ar' ? 'ar' : 'en'}
							onChange={(e) =>
								void onSave({ locale: e.target.value === 'ar' ? 'ar' : 'en' })
							}
							className="ps-10"
						>
							<option value="en" lang="en">
								English
							</option>
							<option value="ar" lang="ar">
								العربية
							</option>
						</Select>
					</span>
				</Field>
				<section aria-label={_(t`Pairing`)} className="space-y-3">
					{paired ? (
						<Item size="sm">
							<ItemMedia variant="icon">
								<Icon name="circle-check" className="text-success size-5" />
							</ItemMedia>
							<ItemContent className="min-w-0">
								<p className="font-semibold">
									<Trans>Paired as {pairedName}</Trans>
								</p>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Terminal {terminalCode}. Orders are sent to your
										restaurant’s server automatically.
									</Trans>
								</p>
								{confirmUnpair ? (
									<div className="notice-danger mt-3 space-y-2 rounded-(--station-control-radius) p-3 text-sm">
										<p>
											{waitingOrders > 0
												? plural(waitingOrders, {
														one: '# order has not been sent yet. They stay on this device and send once it is paired again.',
														other:
															'# orders have not been sent yet. They stay on this device and send once it is paired again.',
													})
												: _(
														t`This device will stop sending orders until it is paired again.`,
													)}
										</p>
										<div className="flex gap-2">
											<Button
												variant="danger"
												onClick={() => {
													onUnpair()
													setConfirmUnpair(false)
												}}
											>
												<Trans>Unpair</Trans>
											</Button>
											<Button
												variant="ghost"
												onClick={() => setConfirmUnpair(false)}
											>
												<Trans>Keep paired</Trans>
											</Button>
										</div>
									</div>
								) : (
									<Button
										variant="ghost"
										className="text-destructive -ms-3 mt-2"
										onClick={() => setConfirmUnpair(true)}
									>
										<Icon name="unlink" className="size-4" />{' '}
										<Trans>Unpair this terminal</Trans>
									</Button>
								)}
							</ItemContent>
						</Item>
					) : (
						<div className="border-border space-y-3 border-t pt-5">
							<div className="flex items-center gap-2 font-semibold">
								<Icon name="link-2" className="size-5 shrink-0" />{' '}
								<Trans>Pair with your restaurant</Trans>
							</div>
							<p className="text-muted-foreground text-sm">
								{required
									? _(
											t`Ask a manager for a pairing link in the Menuza app. Open it on this device, or paste it (or just the code) here.`,
										)
									: _(
											t`Paste a pairing link or code from the Menuza app to send orders to your server.`,
										)}
							</p>
							<Input
								aria-label={_(t`Pairing link or code`)}
								value={pairingText}
								onChange={(e) => {
									setPairingText(e.target.value)
									setPairingError(null)
								}}
								onKeyDown={(e) => {
									// The settings form never submits; Enter here pairs.
									if (e.key !== 'Enter') return
									e.preventDefault()
									void doPair()
								}}
								enterKeyHint="go"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								placeholder={_(t`Pairing link or ppc1.… code`)}
							/>
							<Reveal open={pastedHost !== null}>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Orders will be sent to{' '}
										<bdi className="text-foreground font-semibold">
											{pastedHost}
										</bdi>
										.
									</Trans>
								</p>
							</Reveal>
							<p
								role="alert"
								className="text-destructive text-sm font-medium empty:hidden"
							>
								{pairingError}
							</p>
							<Button
								variant="primary"
								size="lg"
								className="w-full"
								disabled={!pairingText.trim() || pairing}
								onClick={() => void doPair()}
							>
								{pairing ? (
									<Trans>Pairing…</Trans>
								) : (
									<Trans>Pair terminal</Trans>
								)}
							</Button>
						</div>
					)}
				</section>

				{required && !showManual ? (
					<button
						type="button"
						onClick={() => setShowManual(true)}
						className="text-muted-foreground hover:text-foreground min-h-11 text-start text-sm font-medium underline underline-offset-4 transition-colors"
					>
						<Trans>Set up without pairing (menu only)</Trans>
					</button>
				) : (
					<>
						<details
							open={!paired}
							className="group border-border border-y py-2"
						>
							<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
								<Trans>Connection details</Trans>
								<Icon
									name="chevron-down"
									className="size-4 shrink-0 transition-transform group-open:rotate-180"
								/>
							</summary>
							<div className="space-y-4 pt-3 pb-2">
								<Field
									label={_(t`Business address (slug)`)}
									hint={_(t`The name in your site address, e.g. “joes-diner”.`)}
								>
									<Input
										value={draft.slug}
										onChange={(e) => set('slug', e.target.value)}
										autoCapitalize="none"
										autoCorrect="off"
										spellCheck={false}
									/>
								</Field>
								<Field
									label={_(t`App URL`)}
									hint={_(t`Where your Menuza app runs.`)}
								>
									<Input
										value={draft.appUrl}
										onChange={(e) => set('appUrl', e.target.value)}
										inputMode="url"
										autoCapitalize="none"
										autoCorrect="off"
										spellCheck={false}
										placeholder="https://app.example.com"
									/>
								</Field>
								<Field
									label={_(t`Orders server URL`)}
									hint={_(
										t`Regional orders API. Filled in automatically by a pairing link.`,
									)}
								>
									<Input
										value={draft.tenantApiUrl}
										onChange={(e) => set('tenantApiUrl', e.target.value)}
										inputMode="url"
										autoCapitalize="none"
										autoCorrect="off"
										spellCheck={false}
									/>
								</Field>
							</div>
						</details>
						{paired ? (
							<Field
								label={_(t`Staff sign-in`)}
								hint={_(
									t`Turned on or off for this terminal in the Menuza app (Menu, Terminals).`,
								)}
							>
								<p className="border-border bg-muted flex min-h-12 items-center rounded-(--station-control-radius) border px-3 py-2 text-base font-medium">
									{settings.signInRequired ? (
										<Trans>On: staff sign in with their PIN</Trans>
									) : (
										<Trans>Off</Trans>
									)}
								</p>
							</Field>
						) : null}
						{settings.signInRequired ? (
							<Field
								label={_(t`Lock after`)}
								hint={_(
									t`The till locks when nobody has touched it for this long. Staff sign in again with their PIN.`,
								)}
							>
								<Select
									value={draft.idleLockSeconds}
									onChange={(e) =>
										set('idleLockSeconds', Number(e.target.value))
									}
									className={fieldClass}
								>
									{IDLE_LOCK_CHOICES.map((c) => (
										<option key={c.seconds} value={c.seconds}>
											{lockLabel(c.seconds)}
										</option>
									))}
								</Select>
							</Field>
						) : null}
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label={_(t`Terminal code`)}
								hint={
									paired
										? _(t`Set when this terminal was paired.`)
										: _(t`Prefix on order numbers.`)
								}
							>
								<Input
									value={paired ? settings.terminalCode : draft.terminalCode}
									disabled={paired}
									onChange={(e) => set('terminalCode', e.target.value)}
									maxLength={6}
									className={cn('disabled:opacity-60')}
								/>
							</Field>
							{locations.length > 1 ? (
								<Field
									label={_(t`Location`)}
									hint={
										settings.locationLocked
											? _(t`Set when this terminal was paired.`)
											: _(t`Sets tax and menu overrides.`)
									}
								>
									<Select
										value={draft.locationId ?? ''}
										disabled={settings.locationLocked}
										onChange={(e) => set('locationId', e.target.value || null)}
										className={cn(fieldClass, 'disabled:opacity-60')}
									>
										<option value="">{_(t`Default`)}</option>
										{locations.map((l) => (
											<option key={l.id} value={l.id}>
												{l.name}
											</option>
										))}
									</Select>
								</Field>
							) : null}
						</div>
						<label className="hover:bg-muted flex min-h-14 cursor-pointer items-center gap-3 px-1 py-3 transition-colors">
							<Checkbox
								checked={draft.demo}
								onChange={(e) => set('demo', e.target.checked)}
							/>
							<span>
								<span className="block font-medium">
									<Trans>Demo mode</Trans>
								</span>
								<span className="text-muted-foreground text-sm">
									<Trans>Use a sample menu to try the till.</Trans>
								</span>
							</span>
						</label>
						<Reveal open={draft.demo}>
							<label className="hover:bg-muted flex min-h-14 cursor-pointer items-center gap-3 px-1 py-3 transition-colors">
								<Checkbox
									checked={draft.signInRequired}
									onChange={(e) => set('signInRequired', e.target.checked)}
								/>
								<span>
									<span className="block font-medium">
										<Trans>Try staff sign-in</Trans>
									</span>
									<span className="text-muted-foreground text-sm">
										<Trans>
											Lock the till behind a PIN, as paired terminals can. The
											demo PIN is {DEMO_PIN}.
										</Trans>
									</span>
								</span>
							</label>
						</Reveal>
					</>
				)}
				<p
					role="alert"
					className="text-destructive text-sm font-medium empty:hidden"
				>
					{serverProblem}
				</p>
				{!required ? (
					<p className="text-muted-foreground text-sm">
						{lastSyncedAt ? (
							<Trans>Menu last updated {lastUpdated}.</Trans>
						) : (
							<Trans>Menu has not been downloaded yet.</Trans>
						)}
						{error ? (
							<>
								{' '}
								<Trans>Last refresh failed: {error}.</Trans>
							</>
						) : null}
					</p>
				) : null}
			</form>
		</Modal>
	)
}

function Field({
	label,
	hint,
	children,
}: {
	label: string
	hint?: string
	children: React.ReactNode
}) {
	return (
		<label className="block space-y-1.5">
			<span className="text-sm font-semibold">{label}</span>
			{children}
			{hint ? (
				<span className="text-muted-foreground block text-sm">{hint}</span>
			) : null}
		</label>
	)
}
