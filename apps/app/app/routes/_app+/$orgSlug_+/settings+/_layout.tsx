import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet } from 'react-router'

export default function SettingsLayout() {
	const { _ } = useLingui()

	return (
		<WorkspacePage>
			<PageHeader
				title={_(t`Settings`)}
				description={_(t`Manage your restaurant settings and preferences.`)}
			/>
			<Outlet />
		</WorkspacePage>
	)
}
