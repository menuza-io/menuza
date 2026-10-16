import { Trans } from '@lingui/macro'
import { useIsPending } from '@repo/common'
import { Button } from '@repo/ui/button'
import { StatusButton } from '@repo/ui/status-button'
import { Link } from 'react-router'

interface FormActionsProps {
	submitText: React.ReactNode
	cancelTo?: string
	formStatus?: 'success' | 'error' | 'idle'
}

/**
 * Shared form action buttons component
 * Provides Cancel and Submit buttons with consistent styling and behavior
 */
export function FormActions({
	submitText,
	cancelTo = '..',
	formStatus,
}: FormActionsProps) {
	const isPending = useIsPending()

	return (
		<div className="grid w-full grid-cols-2 gap-6">
			<Button variant="secondary" render={<Link to={cancelTo} />}>
				<Trans>Cancel</Trans>
			</Button>
			<StatusButton
				type="submit"
				status={isPending ? 'pending' : (formStatus ?? 'idle')}
			>
				{submitText}
			</StatusButton>
		</div>
	)
}
