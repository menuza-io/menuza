import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PosDeviceApps } from '@repo/common/pos-orders'
import { Icon, type IconName } from '@repo/ui/icon'
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { type StationApp } from '~/lib/config.ts'
import { cn, IconButton, motionMs } from '~/ui/primitives.tsx'

/** One compact entry point. App choices and business identity stay together. */
export function AppLauncher({
	name,
	logoUrl,
	locationName,
	app,
	apps,
	onApp,
	compact = false,
}: {
	compact?: boolean
	name: string
	logoUrl: string | null
	locationName: string | null
	app: StationApp
	apps?: PosDeviceApps
	onApp?: (app: StationApp) => void
}) {
	const { _, i18n } = useLingui()
	const [phase, setPhase] = useState<'gone' | 'entering' | 'open' | 'closing'>(
		'gone',
	)
	const root = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const panel = useRef<HTMLDivElement>(null)
	const id = useId()
	const open = phase === 'entering' || phase === 'open'
	const options: Array<{ value: StationApp; label: string; icon: IconName }> = [
		{ value: 'pos' as const, label: _(t`Register`), icon: 'shopping-bag' },
		{ value: 'kitchen' as const, label: _(t`Kitchen`), icon: 'chef-hat' },
		...(apps?.timeclock
			? [
					{
						value: 'timeclock' as const,
						label: _(t`Time clock`),
						icon: 'clock-3' as const,
					},
				]
			: []),
		...(apps?.reservations
			? [
					{
						value: 'reservations' as const,
						label: _(t`Reservations`),
						icon: 'calendar-days' as const,
					},
				]
			: []),
	]
	const current = options.find((option) => option.value === app) ?? options[0]!
	const dismiss = useCallback((restoreFocus = false) => {
		setPhase('closing')
		if (restoreFocus) trigger.current?.focus({ preventScroll: true })
	}, [])

	useLayoutEffect(() => {
		if (phase === 'entering') {
			void panel.current?.offsetWidth
			setPhase('open')
			panel.current
				?.querySelector<HTMLButtonElement>('[aria-current="page"]')
				?.focus({ preventScroll: true })
		} else if (phase === 'closing') {
			const timer = window.setTimeout(
				() => setPhase('gone'),
				motionMs('--dropdown-close-dur', 150),
			)
			return () => window.clearTimeout(timer)
		}
	}, [phase])

	useEffect(() => {
		if (!open) return
		const outside = (event: Event) => {
			if (event.target instanceof Node && !root.current?.contains(event.target))
				dismiss()
		}
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			dismiss(true)
		}
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', outside)
		document.addEventListener('keydown', escape)
		return () => {
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', outside)
			document.removeEventListener('keydown', escape)
		}
	}, [open, dismiss])

	return (
		<div
			ref={root}
			className={cn(
				'station-launcher relative min-w-0 flex-1',
				compact && '2xl:max-w-48 2xl:flex-none',
			)}
		>
			<IconButton
				ref={trigger}
				data-station-launcher
				label={_(t`Apps`)}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={phase === 'gone' ? undefined : id}
				aria-describedby={`${id}-current`}
				className={cn(
					'h-11 w-auto max-w-full min-w-0 justify-start gap-2 px-1.5 text-start sm:px-2',
					open && 'bg-accent',
				)}
				onClick={() => (open ? dismiss() : setPhase('entering'))}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown') {
						event.preventDefault()
						setPhase('entering')
					}
				}}
			>
				{logoUrl ? (
					<img
						src={logoUrl}
						alt=""
						className="size-8 shrink-0 rounded-(--station-control-radius) object-contain"
					/>
				) : (
					<span
						className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-(--station-control-radius) text-base font-semibold"
						aria-hidden
					>
						{name.slice(0, 1).toUpperCase()}
					</span>
				)}
				<span className="min-w-0">
					<span className="block truncate text-sm leading-tight font-medium">
						{name}
					</span>
					<span className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight">
						<span id={`${id}-current`} className="truncate font-medium">
							{current.label}
						</span>
						{locationName ? (
							<span className="hidden min-w-0 truncate sm:inline">
								<span aria-hidden>· </span>
								{locationName}
							</span>
						) : null}
					</span>
				</span>
				<Icon
					name="grip"
					className="text-muted-foreground hidden size-4 shrink-0 sm:block"
					aria-hidden
				/>
			</IconButton>
			{phase !== 'gone' ? (
				<div
					ref={panel}
					id={id}
					role="dialog"
					aria-label={_(t`Station apps`)}
					aria-hidden={!open || undefined}
					inert={!open}
					data-origin={i18n.locale.startsWith('ar') ? 'top-right' : 'top-left'}
					className={cn(
						't-dropdown bg-popover text-popover-foreground elevated-sheet absolute start-0 top-full z-50 mt-3 max-h-[calc(100dvh-6rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-(--station-panel-radius) p-2',
						phase === 'open' && 'is-open',
						phase === 'closing' && 'is-closing',
					)}
				>
					<div className="border-border mb-2 flex items-center gap-3 border-b px-3 py-4">
						{logoUrl ? (
							<img
								src={logoUrl}
								alt=""
								className="size-10 shrink-0 rounded-(--station-control-radius) object-contain"
							/>
						) : (
							<span
								className="bg-primary text-primary-foreground flex size-10 shrink-0 items-center justify-center rounded-(--station-control-radius) text-base font-semibold"
								aria-hidden
							>
								{name.slice(0, 1).toUpperCase()}
							</span>
						)}
						<div className="min-w-0">
							<p className="font-semibold break-words">{name}</p>
							{locationName ? (
								<p className="text-muted-foreground mt-0.5 text-sm break-words">
									{locationName}
								</p>
							) : null}
						</div>
					</div>
					<nav
						aria-label={_(t`Station apps`)}
						className="flex flex-col gap-1"
						onKeyDown={(event) => {
							const keys = [
								'ArrowLeft',
								'ArrowRight',
								'ArrowUp',
								'ArrowDown',
								'Home',
								'End',
							]
							if (!keys.includes(event.key)) return
							const buttons = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>(
									'button',
								),
							)
							const index = buttons.indexOf(
								document.activeElement as HTMLButtonElement,
							)
							if (index < 0) return
							event.preventDefault()
							const rtl =
								getComputedStyle(event.currentTarget).direction === 'rtl'
							const step =
								event.key === 'ArrowUp'
									? -1
									: event.key === 'ArrowDown'
										? 1
										: event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
											? -1
											: 1
							const next =
								event.key === 'Home'
									? 0
									: event.key === 'End'
										? buttons.length - 1
										: (index + step + buttons.length) % buttons.length
							buttons[next]?.focus()
						}}
					>
						{options.map(({ value, label, icon }) => (
							<button
								key={value}
								type="button"
								aria-current={app === value ? 'page' : undefined}
								className={cn(
									'hover:bg-accent relative flex min-h-12 min-w-0 items-center gap-3 rounded-(--station-control-radius) px-3 py-2 text-sm font-medium transition-colors',
									app === value && 'bg-accent',
								)}
								onClick={() => {
									dismiss(true)
									onApp?.(value)
								}}
							>
								<Icon name={icon} className="size-5" aria-hidden />
								<span className="break-words">{label}</span>
								{app === value ? (
									<Icon
										name="check"
										className="text-success absolute end-2 top-2 size-3.5"
										aria-hidden
									/>
								) : null}
							</button>
						))}
					</nav>
				</div>
			) : null}
		</div>
	)
}
