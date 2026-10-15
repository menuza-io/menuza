import { WorkspacePage } from '@repo/ui/workspace'
import { Outlet, useLocation } from 'react-router'

export default function MarketingLayout() {
	const location = useLocation()

	// Builder routes render full-viewport, skip the layout chrome
	const isBuilderRoute =
		/\/marketing\/automations\/(?:new|[^/]+)$/.test(location.pathname) &&
		!location.pathname.endsWith('/runs')

	if (isBuilderRoute) {
		return <Outlet />
	}

	return (
		<WorkspacePage>
			<Outlet />
		</WorkspacePage>
	)
}
