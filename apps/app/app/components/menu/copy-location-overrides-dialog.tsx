import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'

export function CopyLocationOverridesDialog({
	orgSlug,
	open,
	onOpenChange,
	sourceLocationId,
	locations,
	onCopied,
}: {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	sourceLocationId: string
	locations: Array<{ id: string; name: string }>
	onCopied?: () => void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const [targetId, setTargetId] = useState<string>('')
	const [replace, setReplace] = useState(false)

	const targets = locations.filter((loc) => loc.id !== sourceLocationId)

	const submit = () => {
		if (!targetId) return
		void fetcher.submit(
			JSON.stringify({
				sourceLocationId,
				targetLocationIds: [targetId],
				replace,
			}),
			{
				method: 'POST',
				action: `/${orgSlug}/menu/copy-overrides`,
				encType: 'application/json',
			},
		)
	}

	useEffect(() => {
		if (fetcher.data?.ok) {
			onCopied?.()
			onOpenChange(false)
		}
	}, [fetcher.data, onCopied, onOpenChange])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Copy overrides to another location</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Copies menu overrides from this location. Tick Replace to overwrite
							existing overrides on the target.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label>
							<Trans>Target location</Trans>
						</Label>
						<Select value={targetId} onValueChange={setTargetId}>
							<SelectTrigger>
								<SelectValue placeholder={_(t`Choose a location`)} />
							</SelectTrigger>
							<SelectContent>
								{targets.map((loc) => (
									<SelectItem key={loc.id} value={loc.id}>
										{loc.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox
							id="replace-overrides"
							checked={replace}
							onCheckedChange={(value) => setReplace(value === true)}
						/>
						<Label htmlFor="replace-overrides">
							<Trans>Replace existing overrides on the target</Trans>
						</Label>
					</div>
					{fetcher.data?.error ? (
						<p className="text-destructive text-sm">{fetcher.data.error}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button onClick={submit} disabled={!targetId || fetcher.state !== 'idle'}>
						<Trans>Copy overrides</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
