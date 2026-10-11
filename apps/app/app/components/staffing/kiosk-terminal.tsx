import { type I18n } from '@lingui/core'
import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PositionSwatch } from '@repo/ui/position-color'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { PinPad } from '#app/components/staffing/pin-pad.tsx'
import { formatWallDate, formatWallTime } from '#app/utils/staffing/client.ts'

export type KioskRegion = 'us' | 'ksa'

const STORAGE_KEY = 'staffing.kiosk.v1'
/** Punch tokens live 60 seconds; leave the person screen well before. */
const PERSON_IDLE_MS = 40_000
const DONE_MS = 6_000
const HEARTBEAT_MS = 5 * 60_000

const deviceSchema = z.object({
	id: z.string(),
	name: z.string(),
	locationId: z.string(),
	locationName: z.string(),
	timeZone: z.string(),
})

const storedSchema = z.object({
	v: z.literal(1),
	token: z.string(),
	orgId: z.string(),
	region: z.enum(['us', 'ksa']),
	device: deviceSchema,
})
type Stored = z.infer<typeof storedSchema>

const entrySchema = z.object({
	id: z.string(),
	positionId: z.string().nullable(),
	clockInAt: z.string(),
	clockOutAt: z.string().nullable(),
})

const personSchema = z.object({
	staff: z.object({ firstName: z.string(), lastInitial: z.string() }),
	clockedIn: z.boolean(),
	openEntry: entrySchema.nullable(),
	positions: z.array(
		z.object({ id: z.string(), name: z.string(), colorKey: z.string() }),
	),
	nextShifts: z.array(
		z.object({
			localDate: z.string(),
			startTime: z.string(),
			endTime: z.string(),
			positionId: z.string().nullable(),
		}),
	),
})
type Person = z.infer<typeof personSchema>

const identifySchema = personSchema.extend({ punchToken: z.string() })
const punchSchema = z.object({
	action: z.enum(['in', 'out']),
	entry: entrySchema,
	person: personSchema,
})
const errorSchema = z.object({
	error: z.string(),
	remainingAttempts: z.number().optional(),
	retryAfterSeconds: z.number().optional(),
})

type Screen =
	| { kind: 'loading' }
	| { kind: 'pair' }
	| { kind: 'pin' }
	| {
			kind: 'person'
			person: Person
			punchToken: string
			requestId: string
	  }
	| { kind: 'done'; action: 'in' | 'out'; person: Person; at: string }

class KioskError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly detail: z.infer<typeof errorSchema> | null = null,
	) {
		super(code)
	}
}

function readStored(): Stored | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY)
		if (!raw) return null
		const parsed = storedSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/** Crockford base32: tolerate dashes, spaces, case, and look-alike letters. */
export function normalizePairingCode(input: string) {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1')
}

async function call<T>(
	baseUrl: string,
	path: string,
	schema: z.ZodType<T>,
	init: RequestInit & { token?: string } = {},
): Promise<T> {
	const headers = new Headers(init.headers)
	if (init.token) headers.set('Authorization', `Bearer ${init.token}`)
	if (init.body) headers.set('Content-Type', 'application/json')
	let response: Response
	try {
		response = await fetch(`${baseUrl}/kiosk${path}`, { ...init, headers })
	} catch {
		throw new KioskError(0, 'offline')
	}
	const body: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const error = errorSchema.safeParse(body)
		throw new KioskError(
			response.status,
			error.success
				? error.data.error
				: response.status === 429
					? 'rate_limited'
					: 'request_failed',
			error.success ? error.data : null,
		)
	}
	return schema.parse(body)
}

function kioskErrorMessage(i18n: I18n, error: unknown) {
	if (!(error instanceof KioskError)) {
		return i18n._(msg`Something went wrong. Try again.`)
	}
	const minutes = Math.max(
		1,
		Math.ceil((error.detail?.retryAfterSeconds ?? 60) / 60),
	)
	const remaining = error.detail?.remainingAttempts ?? 0
	const messages: Record<string, string> = {
		offline: i18n._(
			msg`Can’t reach the time clock service. Check the internet connection and try again.`,
		),
		kiosk_disabled: i18n._(
			msg`The time clock is paused. Ask a manager to record your time.`,
		),
		invalid_code: i18n._(
			msg`That pairing code didn’t work. It may have expired or already been used.`,
		),
		invalid_pin: i18n._(
			remaining === 1
				? msg`That PIN didn’t work. One more wrong PIN locks the time clock for a few minutes.`
				: msg`That PIN didn’t work. Try again.`,
		),
		locked: i18n._(
			msg`Too many wrong PINs. Try again in ${minutes} min, or ask a manager.`,
		),
		punch_expired: i18n._(msg`That took too long. Enter your PIN again.`),
		already_clocked_in: i18n._(
			msg`You’re already clocked in. Enter your PIN again to clock out.`,
		),
		not_clocked_in: i18n._(
			msg`You’re already clocked out. Enter your PIN again to clock in.`,
		),
		entry_locked: i18n._(
			msg`This time card is already approved. Ask a manager to clock you out.`,
		),
		not_assigned_here: i18n._(
			msg`You aren’t set up to work at this location. Ask a manager.`,
		),
		unknown_position: i18n._(msg`Choose one of your positions.`),
		rate_limited: i18n._(msg`Too many tries. Wait a minute and try again.`),
	}
	return messages[error.code] ?? i18n._(msg`Something went wrong. Try again.`)
}

export function KioskTerminal({
	organization,
	tenantApiUrls,
}: {
	organization: { id: string; name: string; region: KioskRegion } | null
	tenantApiUrls: Record<KioskRegion, string>
}) {
	const { _, i18n } = useLingui()
	const [stored, setStored] = useState<Stored | null>(null)
	const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
	const [pin, setPin] = useState('')
	const [code, setCode] = useState('')
	const [message, setMessage] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [disabled, setDisabled] = useState(false)
	const [now, setNow] = useState(() => new Date())
	const initialized = useRef(false)

	const baseUrl = stored ? tenantApiUrls[stored.region] : null

	const save = useCallback((next: Stored | null) => {
		if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
		else window.localStorage.removeItem(STORAGE_KEY)
		setStored(next)
	}, [])

	const handleError = useCallback(
		(error: unknown) => {
			if (error instanceof KioskError) {
				if (error.code === 'device_unpaired') {
					save(null)
					setScreen({ kind: 'pair' })
					setMessage(
						_(
							msg`This tablet was removed as a time clock. Pair it again to keep using it.`,
						),
					)
					return
				}
				setDisabled(error.code === 'kiosk_disabled')
			}
			setMessage(kioskErrorMessage(i18n, error))
		},
		[_, i18n, save],
	)

	const pair = useCallback(
		async (rawCode: string) => {
			if (!organization) return
			setBusy(true)
			try {
				const result = await call(
					tenantApiUrls[organization.region],
					'/pair',
					z.object({ deviceToken: z.string(), device: deviceSchema }),
					{
						method: 'POST',
						body: JSON.stringify({
							orgId: organization.id,
							code: normalizePairingCode(rawCode),
						}),
					},
				)
				save({
					v: 1,
					token: result.deviceToken,
					orgId: organization.id,
					region: organization.region,
					device: result.device,
				})
				setCode('')
				setMessage(null)
				setScreen({ kind: 'pin' })
			} catch (error) {
				handleError(error)
				setScreen({ kind: 'pair' })
			} finally {
				setBusy(false)
			}
		},
		[organization, tenantApiUrls, save, handleError],
	)

	useEffect(() => {
		if (initialized.current) return
		initialized.current = true
		const existing = readStored()
		if (existing) {
			setStored(existing)
			setScreen({ kind: 'pin' })
			return
		}
		setScreen({ kind: 'pair' })
		const hashCode = new URLSearchParams(window.location.hash.slice(1)).get('c')
		if (hashCode) {
			// Keep the code out of history and screenshots once it is read.
			window.history.replaceState(
				null,
				'',
				window.location.pathname + window.location.search,
			)
			setCode(hashCode)
			void pair(hashCode)
		}
	}, [pair])

	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 15_000)
		return () => clearInterval(timer)
	}, [])

	// Confirms the device is still paired and lets managers see it is alive.
	useEffect(() => {
		if (!stored || !baseUrl) return
		const check = () =>
			call(baseUrl, '/device', z.object({ device: deviceSchema }), {
				token: stored.token,
			})
				.then((result) => {
					setDisabled(false)
					if (JSON.stringify(result.device) !== JSON.stringify(stored.device)) {
						save({ ...stored, device: result.device })
					}
				})
				.catch((error: unknown) => {
					if (
						error instanceof KioskError &&
						(error.code === 'device_unpaired' ||
							error.code === 'kiosk_disabled')
					) {
						handleError(error)
					}
				})
		void check()
		const timer = setInterval(check, HEARTBEAT_MS)
		return () => clearInterval(timer)
	}, [stored, baseUrl, save, handleError])

	useEffect(() => {
		if (screen.kind !== 'person' && screen.kind !== 'done') return
		const timer = setTimeout(
			() => {
				setScreen({ kind: 'pin' })
				setMessage(null)
			},
			screen.kind === 'person' ? PERSON_IDLE_MS : DONE_MS,
		)
		return () => clearTimeout(timer)
	}, [screen])

	const identify = useCallback(async () => {
		if (!stored || !baseUrl || busy) return
		const entered = pin
		setPin('')
		setBusy(true)
		try {
			const result = await call(baseUrl, '/identify', identifySchema, {
				method: 'POST',
				token: stored.token,
				body: JSON.stringify({ pin: entered }),
			})
			const { punchToken, ...person } = result
			setMessage(null)
			setScreen({
				kind: 'person',
				person,
				punchToken,
				requestId: crypto.randomUUID(),
			})
		} catch (error) {
			handleError(error)
		} finally {
			setBusy(false)
		}
	}, [stored, baseUrl, busy, pin, handleError])

	const punch = useCallback(
		async (action: 'in' | 'out', positionId: string | null) => {
			if (!stored || !baseUrl || screen.kind !== 'person' || busy) return
			setBusy(true)
			try {
				const result = await call(baseUrl, '/punch', punchSchema, {
					method: 'POST',
					token: stored.token,
					body: JSON.stringify({
						punchToken: screen.punchToken,
						action,
						positionId,
						// Reused on retry so a flaky network never double-punches.
						clientRequestId: screen.requestId,
					}),
				})
				setMessage(null)
				setScreen({
					kind: 'done',
					action: result.action,
					person: result.person,
					at:
						result.action === 'in'
							? result.entry.clockInAt
							: (result.entry.clockOutAt ?? result.entry.clockInAt),
				})
			} catch (error) {
				handleError(error)
				if (!(error instanceof KioskError) || error.code !== 'offline') {
					setScreen({ kind: 'pin' })
				}
			} finally {
				setBusy(false)
			}
		},
		[stored, baseUrl, screen, busy, handleError],
	)

	const timeZone = stored?.device.timeZone
	const clock = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	})
	const day = new Intl.DateTimeFormat(i18n.locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone,
	})
	const formatInstant = (iso: string) => clock.format(new Date(iso))
	const organizationName = organization?.name ?? ''

	return (
		<main
			id="main-content"
			className="flex min-h-svh flex-col items-center justify-center gap-8 p-6"
		>
			{stored ? (
				<header className="text-center">
					<p className="text-5xl font-semibold tabular-nums">
						{clock.format(now)}
					</p>
					<p className="text-muted-foreground mt-1">{day.format(now)}</p>
					<p className="text-muted-foreground mt-1 text-sm">
						{stored.device.locationName || stored.device.name}
					</p>
				</header>
			) : null}

			{message ? (
				<p
					role="alert"
					className="bg-muted max-w-md rounded-md p-3 text-center text-sm"
				>
					{message}
				</p>
			) : null}

			{screen.kind === 'loading' ? (
				<p role="status">
					<Trans>Loading…</Trans>
				</p>
			) : null}

			{screen.kind === 'pair' ? (
				organization ? (
					<form
						className="w-full max-w-sm space-y-4"
						onSubmit={(event) => {
							event.preventDefault()
							void pair(code)
						}}
					>
						<div className="space-y-1 text-center">
							<h1 className="text-xl font-semibold">
								<Trans>Set up a time clock for {organizationName}</Trans>
							</h1>
							<p className="text-muted-foreground text-sm">
								<Trans>
									A manager can create a pairing code under Staff → Time clocks.
								</Trans>
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="pairing-code">
								<Trans>Pairing code</Trans>
							</Label>
							<Input
								id="pairing-code"
								dir="ltr"
								autoComplete="off"
								autoCapitalize="characters"
								spellCheck={false}
								className="font-mono text-lg tracking-widest"
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
						</div>
						<Button
							type="submit"
							className="w-full"
							disabled={busy || normalizePairingCode(code).length < 8}
						>
							<Trans>Pair this tablet</Trans>
						</Button>
					</form>
				) : (
					<div className="max-w-md space-y-2 text-center">
						<h1 className="text-xl font-semibold">
							<Trans>Time clock not available</Trans>
						</h1>
						<p className="text-muted-foreground text-sm">
							<Trans>
								Check the address with your manager. The time clock may not be
								turned on for this business.
							</Trans>
						</p>
					</div>
				)
			) : null}

			{screen.kind === 'pin' ? (
				<section className="w-full space-y-4" aria-labelledby="pin-heading">
					<h1 id="pin-heading" className="text-center text-xl font-medium">
						<Trans>Enter your PIN</Trans>
					</h1>
					<PinPad
						value={pin}
						onChange={(next) => {
							setPin(next)
							if (next) setMessage(null)
						}}
						onSubmit={() => void identify()}
						disabled={busy || disabled}
					/>
				</section>
			) : null}

			{screen.kind === 'person' ? (
				<PersonScreen
					person={screen.person}
					busy={busy}
					formatInstant={formatInstant}
					onPunch={(action, positionId) => void punch(action, positionId)}
					onCancel={() => {
						setScreen({ kind: 'pin' })
						setMessage(null)
					}}
				/>
			) : null}

			{screen.kind === 'done' ? (
				<section
					role="status"
					className="max-w-md space-y-4 text-center"
					aria-live="polite"
				>
					<Icon name="check" className="text-primary mx-auto size-12" />
					<DoneMessage
						action={screen.action}
						time={formatInstant(screen.at)}
						firstName={screen.person.staff.firstName}
					/>
					<NextShifts person={screen.person} />
					<Button
						variant="outline"
						onClick={() => {
							setScreen({ kind: 'pin' })
							setMessage(null)
						}}
					>
						<Trans>Done</Trans>
					</Button>
				</section>
			) : null}
		</main>
	)
}

function DoneMessage({
	action,
	time,
	firstName,
}: {
	action: 'in' | 'out'
	time: string
	firstName: string
}) {
	return (
		<p className="text-2xl font-semibold">
			{action === 'in' ? (
				<Trans>
					Clocked in at {time}. Have a good shift, {firstName}!
				</Trans>
			) : (
				<Trans>
					Clocked out at {time}. Thanks, {firstName}!
				</Trans>
			)}
		</p>
	)
}

function PersonScreen({
	person,
	busy,
	formatInstant,
	onPunch,
	onCancel,
}: {
	person: Person
	busy: boolean
	formatInstant: (iso: string) => string
	onPunch: (action: 'in' | 'out', positionId: string | null) => void
	onCancel: () => void
}) {
	const name = `${person.staff.firstName} ${person.staff.lastInitial}`.trim()
	const since = person.openEntry
		? formatInstant(person.openEntry.clockInAt)
		: ''
	return (
		<section className="w-full max-w-md space-y-6 text-center">
			<div className="space-y-1">
				<h1 className="text-3xl font-semibold">
					<Trans>Hi, {name}</Trans>
				</h1>
				<p className="text-muted-foreground">
					{person.clockedIn ? (
						<Trans>Clocked in since {since}</Trans>
					) : (
						<Trans>You’re clocked out</Trans>
					)}
				</p>
			</div>
			{person.clockedIn ? (
				<Button
					className="h-16 w-full text-xl"
					variant="destructive"
					disabled={busy}
					onClick={() => onPunch('out', null)}
				>
					<Icon name="log-out" className="size-5" />
					<Trans>Clock out</Trans>
				</Button>
			) : person.positions.length > 1 ? (
				<div className="space-y-2">
					<p className="text-sm font-medium">
						<Trans>Clock in as</Trans>
					</p>
					{person.positions.map((position) => (
						<Button
							key={position.id}
							className="h-14 w-full text-lg"
							disabled={busy}
							onClick={() => onPunch('in', position.id)}
						>
							<PositionSwatch color={position.colorKey} />
							{position.name}
						</Button>
					))}
				</div>
			) : (
				<Button
					className="h-16 w-full text-xl"
					disabled={busy}
					onClick={() => onPunch('in', null)}
				>
					<Icon name="clock" className="size-5" />
					<Trans>Clock in</Trans>
				</Button>
			)}
			<NextShifts person={person} />
			<Button variant="ghost" onClick={onCancel}>
				<Trans>Not you? Cancel</Trans>
			</Button>
		</section>
	)
}

function NextShifts({ person }: { person: Person }) {
	const { i18n } = useLingui()
	const count = person.nextShifts.length
	const positionName = new Map(person.positions.map((p) => [p.id, p.name]))
	return (
		<div className="text-start">
			<h2 className="text-muted-foreground mb-2 text-sm font-medium">
				<Plural
					value={count}
					_0="No upcoming shifts here"
					one="Your next shift"
					other="Your next # shifts"
				/>
			</h2>
			{count > 0 ? (
				<ul className="divide-border divide-y rounded-md border text-sm">
					{person.nextShifts.map((shift) => (
						<li
							key={`${shift.localDate}-${shift.startTime}`}
							className="flex justify-between gap-3 p-3"
						>
							<span>{formatWallDate(i18n.locale, shift.localDate)}</span>
							<span className="tabular-nums">
								{formatWallTime(i18n.locale, shift.startTime)}–
								{formatWallTime(i18n.locale, shift.endTime)}
							</span>
							<span className="text-muted-foreground">
								{shift.positionId
									? (positionName.get(shift.positionId) ?? '')
									: ''}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}
