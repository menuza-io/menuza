import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type LocationSettingId } from '@repo/common/location-settings-registry'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { createContext, useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { SETTING_LABELS } from './location-setting-labels.ts'

/**
 * What head office decided for this location (#417): the settings it locked
 * (with the reason) and the settings where this location's value differs from
 * the chain default. The server enforces the locks; this only shows them.
 */
export type LocationPolicyView = {
	locked: Array<{ settingId: LocationSettingId; reason: string | null }>
	overrides: LocationSettingId[]
}

type PolicyContextValue = {
	policy: LocationPolicyView
	orgSlug: string
	locationId: string | undefined
}

const EMPTY: PolicyContextValue = {
	policy: { locked: [], overrides: [] },
	orgSlug: '',
	locationId: undefined,
}

const PolicyContext = createContext<PolicyContextValue>(EMPTY)

export function LocationPolicyProvider({
	policy,
	orgSlug,
	locationId,
	children,
}: {
	policy: LocationPolicyView | undefined
	orgSlug: string
	locationId: string | undefined
	children: ReactNode
}) {
	return (
		<PolicyContext.Provider
			value={{ policy: policy ?? EMPTY.policy, orgSlug, locationId }}
		>
			{children}
		</PolicyContext.Provider>
	)
}

/**
 * Wraps the part of the form that edits `settings`. A locked setting shows the
 * reason and its fields are read-only (a disabled fieldset); a setting that
 * overrides the chain default says so and links to where it can be put back.
 */
export function LockableSection({
	settings,
	children,
}: {
	settings: readonly LocationSettingId[]
	children: ReactNode
}) {
	const { _ } = useLingui()
	const { policy, orgSlug, locationId } = useContext(PolicyContext)
	const locked = policy.locked.filter((entry) =>
		settings.includes(entry.settingId),
	)
	const overrides = policy.overrides.filter((id) => settings.includes(id))
	if (locked.length === 0 && overrides.length === 0) return <>{children}</>
	const isLocked = locked.length > 0

	return (
		<div className="space-y-2" data-testid="lockable-section">
			{isLocked ? (
				<div
					role="note"
					data-testid="locked-setting-note"
					className="bg-muted/50 flex items-start gap-2 rounded-md border p-3 text-sm"
				>
					<Icon name="lock" className="mt-0.5 size-4 shrink-0" />
					<div className="min-w-0">
						<p className="font-medium">
							<Trans>Locked by head office</Trans>
						</p>
						<p className="text-muted-foreground">
							{locked
								.map((entry) => _(SETTING_LABELS[entry.settingId]))
								.join(', ')}
						</p>
						{locked
							.filter((entry) => entry.reason)
							.map((entry) => (
								<p
									key={entry.settingId}
									className="text-muted-foreground wrap-anywhere"
								>
									{entry.reason}
								</p>
							))}
						<p className="text-muted-foreground">
							<Trans>
								To change it, ask head office to change the chain default.
							</Trans>
						</p>
					</div>
				</div>
			) : null}
			{overrides.length > 0 ? (
				<div
					className="flex flex-wrap items-center gap-2 text-sm"
					data-testid="override-note"
				>
					<Badge variant="outline">
						<Trans>Overrides the chain default</Trans>
					</Badge>
					{locationId && !isLocked ? (
						<Link
							className="text-primary underline-offset-4 hover:underline"
							to={`/${orgSlug}/settings/locations/compare?setting=${overrides[0]}&locations=${locationId}`}
						>
							<Trans>Use the default again</Trans>
						</Link>
					) : null}
				</div>
			) : null}
			<fieldset
				disabled={isLocked}
				className="m-0 min-w-0 border-0 p-0 disabled:opacity-70"
			>
				{children}
			</fieldset>
		</div>
	)
}
