# Hello Gitty UI Design System

[简体中文](ui-design-system.md) | English

## Design Direction

The visual baseline is the "terminal console" look of the reference design: black canvas, thin-line dividers, information density first, color reserved for state and data. The UI avoids large gradients, heavy shadows, and rounded cards.

## Colors

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#050505` | App canvas, code areas |
| `--panel` | `#090909` | Panels, cards |
| `--panel-2` | `#111111` | Menus, inputs, floating layers |
| `--border` | `#292929` | Default dividers |
| `--border-strong` | `#3a3a3a` | Focus, drag, and emphasized boundaries |
| `--text` | `#ededed` | Body text and primary values |
| `--text-head` | `#c9c9c9` | Headings |
| `--text-dim` | `#9a9a9a` | Secondary info, paths, timestamps |
| `--accent` | `#7d5cdf` | Selection, AI, branch, and commit actions |
| `--orange` | `#ff9d00` | Running, ports, and activity data |
| `--green` | `#00d084` | Success, completed, running |
| `--red` | `#ff6b6b` | Conflicts, deletions, dangerous actions |

## Typography & Hierarchy

- Body text uses the system sans-serif font for reliable Chinese rendering.
- Numbers, paths, commands, status labels, and group headings use `ui-monospace`.
- Page titles 14–16px; group labels 11–12px using uppercase/letter-spacing for hierarchy; body 12–13px.
- Numbers use high-contrast white; explanatory text drops to `--text-dim` so nothing competes for attention.

## Layout & Components

- Pages use 1px dividers and an 8/12/16/24px spacing rhythm.
- Buttons, inputs, tags, badges, and cards are strictly square-cornered to avoid the generic SaaS card look.
- Interactive controls are transparent or black by default; hover raises one gray step; selected states use a purple left border/outline instead of large purple fills.
- Data cards keep borders and use no shadows; chart grid lines use low-contrast gray.
- Destructive actions must be red and keep the existing confirmation flow.

## Page Application

- Overview: KPI in three columns, activity and type stats, project cards and run states; purple for commits/AI, orange for running/ports.
- Project page: project identity and branch at the top, a compact action bar; staged, modified, conflicts, and history as linear groups.
- Diff/logs: a darker code canvas with low-opacity green/red backgrounds for added/removed lines.
- Settings and confirmation dialogs: black background, thin borders, square corners; danger notes appear only for irreversible actions.
