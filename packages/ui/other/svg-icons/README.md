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

It's important that you only add icons to this directory that the application
actually needs: `npm run generate:icons` builds one sprite from every file here.
See `docs/icons.md`.
