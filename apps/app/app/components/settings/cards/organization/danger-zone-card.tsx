import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import {
	Frame,
	FramePanel,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import { Form } from 'react-router'

export default function DangerZoneCard({
	organization,
}: {
	organization: { id: string; name: string }
}) {
	const [isOpen, setIsOpen] = useState(false)
	const [confirmationText, setConfirmationText] = useState('')
	const [isConfirmed, setIsConfirmed] = useState(false)

	const isDeleteEnabled = confirmationText === organization.name && isConfirmed
	const orgName = organization.name

	const handleSubmit = () => {
		if (isDeleteEnabled) {
			// The form will handle the actual submission
			setIsOpen(false)
		}
	}

	return (
		<Frame className="border-destructive/20 bg-destructive/5 dark:bg-destructive/30">
			<FrameHeader>
				<FrameTitle className="text-destructive">
					<Trans>Danger</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Destructive settings that cannot be undone. All your data will be
						permanently removed from our servers.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="space-y-4">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 flex-1">
						<h3 className="text-foreground mb-2 font-medium">
							<Trans>Delete restaurant</Trans>
						</h3>
						<p className="text-muted-foreground text-sm text-pretty">
							<Trans>
								By deleting your restaurant you and your team will lose access
								and all data will be lost. This is a permanent action and cannot
								be undone.
							</Trans>
						</p>
					</div>
					<Dialog open={isOpen} onOpenChange={setIsOpen}>
						<DialogTrigger
							render={
								<Button variant="destructive" className="shrink-0 self-start">
									<Icon name="trash-2" />
									<Trans>Delete restaurant</Trans>
								</Button>
							}
						></DialogTrigger>
						<DialogContent className="sm:max-w-md">
							<DialogHeader>
								<DialogTitle className="text-destructive">
									<Trans>Delete restaurant?</Trans>
								</DialogTitle>
								<DialogDescription>
									<Trans>
										By deleting your restaurant you and your team will lose
										access and all data will be lost. This is a permanent action
										and cannot be undone.
									</Trans>
								</DialogDescription>
							</DialogHeader>

							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="confirmation">
										<Trans>
											Type the restaurant name "{orgName}" to confirm.
										</Trans>
									</Label>
									<Input
										id="confirmation"
										value={confirmationText}
										onChange={(e) => setConfirmationText(e.target.value)}
										placeholder={organization.name}
										className="mt-2"
									/>
								</div>

								<div className="flex space-x-2">
									<Checkbox
										id="understand"
										checked={isConfirmed}
										onCheckedChange={(checked) =>
											setIsConfirmed(checked === true)
										}
										className="mt-1"
									/>
									<Label htmlFor="understand" className="text-sm">
										<Trans>
											I'll not be able to access the restaurant and its data
											anymore
										</Trans>
									</Label>
								</div>
							</div>

							<DialogFooter className="gap-2">
								<Button variant="outline" onClick={() => setIsOpen(false)}>
									<Trans>Cancel</Trans>
								</Button>
								<Form method="POST" onSubmit={handleSubmit}>
									<input
										type="hidden"
										name="intent"
										value="delete-organization"
									/>
									<Button
										type="submit"
										variant="destructive"
										disabled={!isDeleteEnabled}
									>
										<Trans>Confirm</Trans>
									</Button>
								</Form>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</div>
			</FramePanel>
		</Frame>
	)
}
