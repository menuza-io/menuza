# Icons

These icons were downloaded from https://icons.radix-ui.com/ which is licensed
under MIT: https://github.com/radix-ui/icons/blob/master/LICENSE

Integration brand marks retain their brand colors rather than inheriting the
interface's text color. Sources:

- Google:
  [official Google G SVG](https://fonts.gstatic.com/s/i/productlogos/googleg/v6/24px.svg).
- Clover:
  [official favicon symbol](https://cloverstatic.com/content/icons/web/favicons/safari-pinned-tab.svg),
  with the `#228800` mask-icon color published on `clover.com`.
- Toast, OpenTable, and Resy: the symbol paths from their logo SVGs on Wikimedia
  Commons ([Toast](https://commons.wikimedia.org/wiki/File:Toast_logo.svg),
  [OpenTable](https://commons.wikimedia.org/wiki/File:OpenTable_logo.svg),
  [Resy](https://commons.wikimedia.org/wiki/File:Resy_logo.svg)).
- Yelp, TripAdvisor, Deliveroo, Just Eat, Square, Uber Eats, and DoorDash:
  [Simple Icons](https://simpleicons.org/) (CC0), using the paths and colors
  from the installed `@icons-pack/react-simple-icons` package. Square keeps a
  white backing so its dark mark remains legible in dark mode.

Brand names and logos remain the trademarks of their respective owners.

It's important that you only add icons to this directory that the application
actually needs as the `vite-plugin-icons-spritesheet` plugin is configured to
generate a spritesheet with icons from this directory. The plugin re-runs on
every edit/delete/add to this directory.
