# Icons

These icons come from [Hugeicons](https://github.com/hugeicons/hugeicons)
(stroke rounded, MIT: https://github.com/hugeicons/hugeicons/blob/main/LICENSE)
through Iconify. The brand logos (Asana, ClickUp, GitHub, GitLab, Google, Jira,
Linear, Notion, Slack, Trello) and `passkey.svg` are the exceptions.

Several files keep an older name but hold a Hugeicons icon: the first line of
each file names its source, for example `trash-2.svg` is `hugeicons/delete-02`.

Icons added for Station (the till, kitchen and host stand) come from
[Hugeicons](https://hugeicons.com/) free icons, MIT licensed, copied from the
installed `@hugeicons/core-free-icons` package (4.3.5). Each file names its
Hugeicons source in a comment; the file name stays the name the code uses.

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
actually needs: `npm run generate:icons` builds one sprite from every file here.
See `docs/icons.md`.
