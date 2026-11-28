'use client'

import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type HoursFix,
	type HoursScope,
	type HoursWarning,
} from '@repo/common/hours-lint'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { hoursWarningText } from '#app/utils/location/hours-warnings.ts'

/**
 * Warnings about opening hours that look like a mistake (#275). They never
 * block saving: each one says what looks wrong, offers a one-click fix where
 * one is obvious, and the whole list can be dismissed until the hours change.
 */
export function HoursWarningsPanel({
	warnings,
	scopes,
	onFix,
	onDismiss,
	dismissDisabledReason = null,
	dismissing = false,
}: {
	warnings: readonly HoursWarning[]
	/** Which kinds of warning this panel lists (store and online, or special). */
	scopes: readonly HoursScope[]
	onFix: (fix: HoursFix) => void
	/** Omitted: no dismiss button (the other panel carries it). */
	onDismiss?: () => void
	/** Why dismissing is off right now (unsaved hour changes). */
	dismissDisabledReason?: string | null
	dismissing?: boolean
}) {
	const { _, i18n } = useLingui()
	const shown = warnings.filter((warning) => scopes.includes(warning.scope))
	if (shown.length === 0) return null
	return (
		<Alert data-testid="hours-warnings">
			<Icon name="alert-triangle" />
			<AlertTitle>
				<Trans>These hours may have a mistake</Trans>
			</AlertTitle>
			<AlertDescription>
				<ul className="flex flex-col gap-3">
					{shown.map((warning) => {
						const text = hoursWarningText(warning, _, i18n.locale)
						return (
							<li
								key={warning.key}
								className="flex flex-wrap items-start justify-between gap-2"
								data-testid="hours-warning"
								data-code={warning.code}
							>
								<div className="min-w-0 flex-1">
									<p className="text-foreground text-sm font-medium">
										{text.title}
									</p>
									{text.detail ? (
										<p className="text-xs">{text.detail}</p>
									) : null}
								</div>
								{warning.fix && text.fixLabel ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => onFix(warning.fix!)}
									>
										{text.fixLabel}
									</Button>
								) : null}
							</li>
						)
					})}
				</ul>
				{onDismiss ? (
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={dismissing || dismissDisabledReason !== null}
							onClick={onDismiss}
						>
							<Trans>Dismiss until the hours change</Trans>
						</Button>
						{dismissDisabledReason ? (
							<span className="text-xs">{dismissDisabledReason}</span>
						) : null}
					</div>
				) : null}
			</AlertDescription>
		</Alert>
	)
}
