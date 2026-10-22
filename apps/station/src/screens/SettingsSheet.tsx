import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CheckCircle2, Languages, Link2, Unlink } from 'lucide-react'
import { useState } from 'react'
import { IDLE_LOCK_CHOICES } from '~/lib/activity.ts'
import { type PosSettings } from '~/lib/config.ts'
import { DEMO_PIN } from '~/lib/signin.ts'
import { type MenuLocation } from '~/lib/types.ts'
import { Button, Modal } from '~/ui/primitives.tsx'

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
	const valid = draft.demo || (draft.appUrl.trim() && draft.slug.trim())
	/** Idle-lock choices, worded in the till's language. */
	const lockLabel = (seconds: number) =>
		seconds === 0
			? _(t`Never`)
			: seconds < 60
				? _(plural(seconds, { one: '# second', other: '# seconds' }))
				: _(plural(seconds / 60, { one: '# minute', other: '# minutes' }))

	const doPair = async () => {
		setPairing(true)
		setPairingError(null)
		const problem = await onPair(pairingText)
		setPairing(false)
		if (problem) setPairingError(problem)
		else {
			setPairingText('')
			onClose()
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
						<Languages className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2" />
						<select
							// The language in use now: chosen here, or the restaurant's default.
							value={i18n.locale === 'ar' ? 'ar' : 'en'}
							onChange={(e) =>
								void onSave({ locale: e.target.value === 'ar' ? 'ar' : 'en' })
							}
							className={`${inputClass} ps-10`}
						>
							<option value="en" lang="en">
								English
							</option>
							<option value="ar" lang="ar">
								العربية
							</option>
						</select>
					</span>
				</Field>
				<section aria-label={_(t`Pairing`)} className="space-y-3">
					{paired ? (
						<div className="border-success/40 bg-success/8 flex items-start gap-3 rounded-2xl border p-4">
							<CheckCircle2 className="text-success mt-0.5 size-6 shrink-0" />
							<div className="min-w-0 flex-1">
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
									<div className="bg-destructive/10 mt-3 space-y-2 rounded-xl p-3 text-sm">
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
										<Unlink className="size-4" />{' '}
										<Trans>Unpair this terminal</Trans>
									</Button>
								)}
							</div>
						</div>
					) : (
						<div className="border-border space-y-3 rounded-2xl border p-4">
							<div className="flex items-center gap-2 font-semibold">
								<Link2 className="size-5 shrink-0" />{' '}
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
							<input
								aria-label={_(t`Pairing link or code`)}
								value={pairingText}
								onChange={(e) => {
									setPairingText(e.target.value)
									setPairingError(null)
								}}
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								placeholder={_(t`Pairing link or ppc1.… code`)}
								className={inputClass}
							/>
							{pairingError ? (
								<p
									role="alert"
									className="text-destructive text-sm font-medium"
								>
									{pairingError}
								</p>
							) : null}
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
						className="text-muted-foreground text-sm font-medium underline underline-offset-4"
					>
						<Trans>Set up without pairing (menu only)</Trans>
					</button>
				) : (
					<>
						<Field
							label={_(t`Business address (slug)`)}
							hint={_(t`The name in your site address, e.g. “joes-diner”.`)}
						>
							<input
								value={draft.slug}
								onChange={(e) => set('slug', e.target.value)}
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								className={inputClass}
							/>
						</Field>
						<Field
							label={_(t`App URL`)}
							hint={_(t`Where your Menuza app runs.`)}
						>
							<input
								value={draft.appUrl}
								onChange={(e) => set('appUrl', e.target.value)}
								inputMode="url"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								placeholder="https://app.example.com"
								className={inputClass}
							/>
						</Field>
						<Field
							label={_(t`Orders server URL`)}
							hint={_(
								t`Regional orders API. Filled in automatically by a pairing link.`,
							)}
						>
							<input
								value={draft.tenantApiUrl}
								onChange={(e) => set('tenantApiUrl', e.target.value)}
								inputMode="url"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								className={inputClass}
							/>
						</Field>
						{paired ? (
							<Field
								label={_(t`Staff sign-in`)}
								hint={_(
									t`Turned on or off for this terminal in the Menuza app (Menu, Terminals).`,
								)}
							>
								<p className="border-border bg-muted flex h-12 items-center rounded-xl border px-3 text-base font-medium">
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
								<select
									value={draft.idleLockSeconds}
									onChange={(e) =>
										set('idleLockSeconds', Number(e.target.value))
									}
									className={inputClass}
								>
									{IDLE_LOCK_CHOICES.map((c) => (
										<option key={c.seconds} value={c.seconds}>
											{lockLabel(c.seconds)}
										</option>
									))}
								</select>
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
								<input
									value={paired ? settings.terminalCode : draft.terminalCode}
									disabled={paired}
									onChange={(e) => set('terminalCode', e.target.value)}
									maxLength={6}
									className={`${inputClass} disabled:opacity-60`}
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
									<select
										value={draft.locationId ?? ''}
										disabled={settings.locationLocked}
										onChange={(e) => set('locationId', e.target.value || null)}
										className={`${inputClass} disabled:opacity-60`}
									>
										<option value="">{_(t`Default`)}</option>
										{locations.map((l) => (
											<option key={l.id} value={l.id}>
												{l.name}
											</option>
										))}
									</select>
								</Field>
							) : null}
						</div>
						<label className="border-border flex items-center gap-3 rounded-xl border p-3">
							<input
								type="checkbox"
								checked={draft.demo}
								onChange={(e) => set('demo', e.target.checked)}
								className="size-5 shrink-0"
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
						{draft.demo ? (
							<label className="border-border flex items-center gap-3 rounded-xl border p-3">
								<input
									type="checkbox"
									checked={draft.signInRequired}
									onChange={(e) => set('signInRequired', e.target.checked)}
									className="size-5 shrink-0"
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
						) : null}
					</>
				)}
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

const inputClass =
	'h-12 w-full rounded-xl border border-input bg-background px-3 text-base outline-none focus:border-ring'

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
