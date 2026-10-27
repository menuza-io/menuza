# Icons

The Epic Stack uses SVG sprites for
[optimal icon performance](https://benadam.me/thoughts/react-svg-sprites/).
You'll find raw SVGs in the `packages/ui/other/svg-icons` directory. The
`packages/ui/generate-icons.js` script (`npm run generate:icons`) compiles them
into a `sprite.svg` file plus an `icon-name.d.ts` file that lets TypeScript pick
up the icon names. It writes them to `packages/ui/components/icons/` and copies
them to `app/components/ui/icons/` in `apps/app` and `apps/admin`. Turbo also
runs it before the `@repo/ui` build and before `npm run dev:app` or the root
`npm run dev`.

The icons come from [Hugeicons](https://github.com/hugeicons/hugeicons) (the
free stroke-rounded set, MIT). The brand logos (GitHub, Google, Slack and so on)
and `passkey.svg` are the exceptions. Some files keep an older name and hold a
Hugeicons icon; the first line of each file names its source, for example
`trash-2.svg` holds `hugeicons/delete-02`.

You can use [Sly](https://github.com/jacobparis-insiders/sly/tree/main/cli) to
add new icons from the command line. To add `delete-02` and `user-add-01`, run:

```sh
npx @sly-cli/sly add iconify:hugeicons delete-02 user-add-01
```

If you don't specify the icons, Sly shows an interactive list of the Hugeicons
collection. Browse the names at
[github.com/hugeicons/hugeicons](https://github.com/hugeicons/hugeicons/tree/main/icons)
or [hugeicons.com](https://hugeicons.com/icons). Sly reads the icons from
Iconify, which serves them with `currentColor` strokes; the raw files on GitHub
use a hard-coded `#141B34` stroke instead.

Sly has been configured to add the icons to the `packages/ui/other/svg-icons`
directory, so there are no extra steps to take. You can see the configuration in
the `sly/sly.json` file.

Once you've added new files in the directory, run `npm run generate:icons` and
you can then use the `Icon` component from `@repo/ui/icon` to render it. The
`name` prop is the name of the file without the `.svg` extension. We recommend
using `kebab-case` filenames rather than `PascalCase` to avoid casing issues
with different operating systems.

By default, all the icons will have a height and width of `1em` so they should
match the font-size of the text they're next to. You can also customize the size
using the `size` prop.

## Animated icons

The App and Admin sidebars and the user menu use hover-animated icons instead of
the sprite: `@repo/ui/home-icon`, `@repo/ui/settings-gear-icon` and the other
files in `packages/ui/components/animated-icons/`, plus the App-only ones in
`apps/app/app/components/icons/`. They draw Hugeicons paths and animate parts of
them with [Motion](https://motion.dev/).

Build a new one with `createAnimatedIcon` from `@repo/ui/animated-icon`:

1. Copy the icon's `<path>` and `<circle>` elements from
   [the Hugeicons repo](https://github.com/hugeicons/hugeicons/tree/main/icons)
   and drop their `stroke*` attributes. Use the GitHub file rather than the
   Iconify one: it keeps each part of the icon as its own element, and you
   animate parts separately.
2. Turn the parts that move into `motion.*` elements with `animate={controls}`
   and variants named `normal` (at rest) and `animate`. Put any transform origin
   (`originX`, `originY`) inside the variants; inline styles fail the design
   lint.

```tsx
import { type Variants, motion } from 'motion/react'
import {
	type AnimatedIconHandle,
	createAnimatedIcon,
} from '@repo/ui/animated-icon'

export type HomeIconHandle = AnimatedIconHandle

const DOOR_VARIANTS: Variants = {
	normal: { pathLength: 1, opacity: 1 },
	animate: { pathLength: [0, 1], opacity: [0, 1] },
}

export const HomeIcon = createAnimatedIcon('HomeIcon', (controls) => (
	<>
		<path d="M3 11.9896V14.5C3 17.7998 ..." />
		<motion.path
			d="M15 21.5V16.5C15 ..."
			variants={DOOR_VARIANTS}
			animate={controls}
		/>
	</>
))
```

An icon animates on hover by itself. When a parent passes a `ref`, the parent
drives it with `ref.current.startAnimation()` and `stopAnimation()`; the
sidebars do this so that hovering anywhere on the row animates the icon. Nothing
moves when the user prefers reduced motion.
