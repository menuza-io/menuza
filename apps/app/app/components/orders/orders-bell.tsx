import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CHIME_SOUNDS, type ChimeSound } from '@repo/common/order-chime'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { Switch } from '@repo/ui/switch'
import { useId } from 'react'
import { type useNewOrderAlerts } from '#app/hooks/use-new-order-alerts.ts'
import { playSample } from '#app/utils/orders/waiting-chime.ts'

type Alerts = ReturnType<typeof useNewOrderAlerts>

const SOUND_LABELS: Record<ChimeSound, ReturnType<typeof msg>> = {
	chime: msg`Chime`,
	bell: msg`Bell`,
	pulse: msg`Pulse`,
}

/**
 * The bell on the Orders page (#265): sound on or off, volume, one of three
 * sounds, a Test button and desktop notifications, remembered per browser. When
 * the browser blocks sound the page says so right here. The first visit shows a
 * one-line prompt to turn the sound on.
 */
export function OrdersBell({ alerts }: { alerts: Alerts }) {
	const { _ } = useLingui()
	const id = useId()
	const { prefs, setPrefs, test, permission, requestPermission } = alerts
	return (
		<div className="flex flex-col items-end gap-2">
			<div className="flex items-center gap-2">
				{alerts.soundBlocked ? (
					<p
						role="status"
						className="text-warning text-xs"
						data-testid="orders-sound-blocked"
					>
						{alerts.soundUnsupported ? (
							<Trans>This browser cannot play sound.</Trans>
						) : (
							<Trans>
								Your browser is blocking sound. Click anywhere on the page, or
								press Test.
							</Trans>
						)}
					</p>
				) : null}
				<Popover>
					<PopoverTrigger
						render={
							<Button
								variant="outline"
								size="sm"
								aria-label={_(msg`Order alert sound`)}
								data-testid="orders-bell"
							>
								<Icon
									name={prefs.enabled ? 'bell' : 'volume-x'}
									className="size-4"
								/>
								{prefs.enabled ? (
									<Trans>Sound on</Trans>
								) : (
									<Trans>Sound off</Trans>
								)}
							</Button>
						}
					/>
					<PopoverContent align="end" className="w-80 space-y-4">
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor={`${id}-on`}>
								<Trans>Sound for new orders</Trans>
							</Label>
							<Switch
								id={`${id}-on`}
								checked={prefs.enabled}
								onCheckedChange={(enabled) =>
									setPrefs({ enabled, promptAnswered: true })
								}
							/>
						</div>
						<div className="grid gap-1">
							<Label htmlFor={`${id}-volume`}>
								<Trans>Volume</Trans>
							</Label>
							<input
								id={`${id}-volume`}
								type="range"
								min={0}
								max={100}
								step={5}
								value={Math.round(prefs.volume * 100)}
								onChange={(event) =>
									setPrefs({ volume: Number(event.target.value) / 100 })
								}
								data-testid="orders-volume"
							/>
						</div>
						<fieldset className="grid gap-1">
							<legend className="text-sm font-medium">
								<Trans>Sound</Trans>
							</legend>
							<div className="flex gap-2">
								{CHIME_SOUNDS.map((sound) => (
									<Button
										key={sound}
										type="button"
										size="sm"
										variant={prefs.sound === sound ? 'default' : 'outline'}
										aria-pressed={prefs.sound === sound}
										data-testid={`orders-sound-${sound}`}
										onClick={() => {
											setPrefs({ sound })
											playSample(sound, prefs.volume)
										}}
									>
										{_(SOUND_LABELS[sound])}
									</Button>
								))}
							</div>
						</fieldset>
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-testid="orders-test-sound"
							onClick={() => void test()}
						>
							<Icon name="volume-2" className="size-4" />
							<Trans>Test</Trans>
						</Button>
						<div className="grid gap-1">
							<span className="text-sm font-medium">
								<Trans>Desktop notifications</Trans>
							</span>
							{permission === 'granted' ? (
								<p className="text-muted-foreground text-xs">
									<Trans>
										On. You get a notification when this tab is in the
										background.
									</Trans>
								</p>
							) : permission === 'denied' ? (
								<p className="text-muted-foreground text-xs">
									<Trans>Blocked in your browser settings.</Trans>
								</p>
							) : permission === 'unsupported' ? (
								<p className="text-muted-foreground text-xs">
									<Trans>This browser does not show them.</Trans>
								</p>
							) : (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void requestPermission()}
								>
									<Trans>Allow notifications</Trans>
								</Button>
							)}
						</div>
					</PopoverContent>
				</Popover>
			</div>
			{!prefs.promptAnswered && !prefs.enabled ? (
				<div
					className="text-muted-foreground flex flex-wrap items-center justify-end gap-2 text-sm"
					data-testid="orders-sound-prompt"
				>
					<span>
						<Trans>Turn on sound to hear new orders.</Trans>
					</span>
					<Button
						size="sm"
						onClick={() => setPrefs({ enabled: true, promptAnswered: true })}
					>
						<Trans>Turn on sound</Trans>
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setPrefs({ promptAnswered: true })}
					>
						<Trans>Not now</Trans>
					</Button>
				</div>
			) : null}
		</div>
	)
}
