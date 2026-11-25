import { Trans } from '@lingui/macro'
import { type PosOwnershipField } from '@repo/integrations/pos/ownership'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link, useFetcher, useFormAction } from 'react-router'
import { type PosEntityLockInfo } from '#app/utils/menu/pos-ownership.server.ts'

export function PosManagedBadge({ lock }: { lock?: PosEntityLockInfo }) {
	if (!lock?.isLinked || lock.providers.length === 0) return null
	const providerLabel = lock.providers.join(', ')
	return (
		<Badge variant="secondary" className="shrink-0 gap-1">
			<Icon name="link-2" className="size-3" />
			<Trans>Managed in {providerLabel}</Trans>
		</Badge>
	)
}

function formatPosValuePreview(
	field: PosOwnershipField,
	value: unknown,
): string | null {
	if (value === undefined) return null
	if (field === 'price' && typeof value === 'number') {
		return `$${value.toFixed(2)}`
	}
	if (field === 'name' || field === 'description') {
		if (typeof value === 'string' && value.trim()) {
			const trimmed = value.trim()
			return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
		}
		return null
	}
	return null
}

export function PosFieldControl({
	lock,
	field,
	orgSlug,
}: {
	lock?: PosEntityLockInfo
	field: PosOwnershipField
	orgSlug: string
}) {
	const fetcher = useFetcher()
	const actionUrl = useFormAction('.')

	if (!lock?.isLinked) return null

	const isLocked = lock.lockedFields.includes(field)
	const isOverridden = lock.overriddenFields.includes(field)
	if (!isLocked && !isOverridden) return null

	const busy = fetcher.state !== 'idle'
	const provider =
		lock.lockedFieldProviders[field] ?? lock.providers[0] ?? 'POS'

	if (isLocked) {
		const canOverride = lock.allowlistedFields.includes(field)
		return (
			<div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
				<span className="text-muted-foreground inline-flex flex-wrap items-center gap-1.5">
					<Icon name="lock" className="size-3 shrink-0" />
					<span>
						<Trans>Managed in {provider}.</Trans>{' '}
						<Link
							to={`/${orgSlug}/settings/integrations`}
							className="text-primary underline underline-offset-4"
						>
							<Trans>Change ownership</Trans>
						</Link>
					</span>
				</span>
				{canOverride ? (
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={busy}
						onClick={() => {
							void fetcher.submit(
								{ intent: 'override-pos-field', field },
								{ method: 'POST', action: actionUrl },
							)
						}}
					>
						<Trans>Use my own</Trans>
					</Button>
				) : null}
			</div>
		)
	}

	const preview = formatPosValuePreview(field, lock.posValues[field])
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="outline" className="px-1.5 py-0 text-[11px]">
					<Trans>Yours, not from POS</Trans>
				</Badge>
				{preview ? (
					<span className="text-muted-foreground">
						<Trans>POS value: {preview}</Trans>
					</span>
				) : null}
			</div>
			<Button
				type="button"
				variant="outline"
				size="xs"
				disabled={busy}
				onClick={() => {
					void fetcher.submit(
						{ intent: 'restore-pos-field', field },
						{ method: 'POST', action: actionUrl },
					)
				}}
			>
				<Icon name="rotate-ccw" className="size-3" />
				<Trans>Restore from POS</Trans>
			</Button>
		</div>
	)
}
