# Design

A desktop calendar for Google Calendar, macOS and Linux. It exists because Google Calendar
wastes vertical space you cannot reclaim and surrounds the grid with chrome you never asked
for. Everything below follows from those two complaints.

## The grid owns the window

There is no permanent sidebar. The mini-month, the calendar list, search and settings are all
overlays: summoned by a key or a hover, dismissed with Escape, never resident. The only
persistent chrome is a single header row carrying the date range, the view switcher and the
current time range. On macOS the traffic lights float over that row, so it costs no extra
height.

This is the whole point. A 1440p monitor should show a week of your life, not a week of your
life inside a browser inside a Google header.

## Vertical fit

The grid never scrolls. Row height is derived from the window, so whatever range is visible
always fits exactly.

The visible range is computed from the events in the span you are looking at: floor to the
hour before your earliest event, ceil to the hour after your latest, clamped to a minimum of
eight hours so a quiet week does not render four enormous rows. Empty bands at the top and
bottom fold into thin strips labelled with their range and a count of anything hiding inside.
Click or press `z` to unfold one.

The range expands immediately when it needs to, but only contracts when it would shrink by two
hours or more. Without that hysteresis the axis flickers as you page through weeks, and a
flickering axis destroys the positional memory that makes a keyboard-driven calendar fast.

The hour you are in is the one exception to the range being the events' business. At half
eleven at night the events stopped hours ago, so the now line has nowhere to land and the app
stops telling you where in the day you are, which is most of what a calendar is open for. So
when today is on screen the axis takes that hour in, and folds away everything it reached over
to get there: the axis grows by a row and a strip, not by an evening. Page to a week that does
not contain today and it goes again, which is the one place the axis is allowed to move under
you.

Interior gaps stay at full scale. A three-hour hole on a Wednesday afternoon is the most
useful thing on the screen, because it is where work goes, and folding it automatically would
make a packed day look identical to an open one. But you can fold one deliberately with `z`,
and it stays folded across navigation until you unfold it. The fold is per range, remembered
in local state, not derived from the data.

One consequence worth stating plainly: within the unfolded region the scale is strictly
linear, so a block twice as tall is an event twice as long, always. That property is why the
grid is worth having at all, and it is the thing automatic gap-folding would have cost.

## Events on the grid

Overlapping events use the standard constraint model. Sort by start, partition into collision
clusters, assign each event the leftmost free column within its cluster, then let every event
expand rightward into columns that stay free for its whole duration. Colliding events end up
the same width, nothing visually overlaps, and an event that only collides briefly still gets
most of the day's width.

An event block is a washed neutral surface with a two-pixel coloured edge on the left
identifying its calendar. Colour never fills the block. This keeps the grid quiet enough to
read as a shape while still letting you tell work from personal at a glance, and it means the
app looks like a sibling of margin rather than a different product.

All-day events sit in a fixed band under the day headers, one row tall, with anything that does
not fit behind a count that expands over the grid. The band's height has to be constant: the axis
below is solved from whatever height is left, so a band that grew with its contents would change
the row height as you paged and slide every hour on the grid, which is the same positional memory
the contraction hysteresis exists to protect. A taller fixed reserve would be the other sin, an
empty band eating space you cannot reclaim.

## Keyboard

Keyboard-first, mouse fully supported. Drag on empty grid to create, drag a block to move it,
drag its edge to resize. None of that is second class.

Navigation is `h` and `l` for previous and next day, `H` and `L` for week, `t` for today.
`j` and `k` move the selection through the events of the focused day. `d`, `w` and `a` switch
view, and `m` summons the mini-month, since there is no month view for it to switch to. `z`
folds or unfolds the band under the cursor.

Actions are `c` to create, `Enter` to open the selection, `e` to edit, `x` to delete, `/` to
search, `Escape` to dismiss whatever is open. `Cmd-K` opens the command palette, which is also
where creation happens.

Every binding is listed in an overlay behind `?`. Nothing is modal and nothing is chorded.
Vimcal's ceiling is higher and its users find it confusing, which is a trade worth refusing.

## On a phone

Keyboard-first stops being a design when there is no keyboard, so a phone gets a different set of
affordances for the same commands rather than a shrunken copy of the desktop ones. The build steps
are in [mobile.md](mobile.md); the decisions are here.

The chrome inverts. The desktop header holds three groups across a single row and there is no
arrangement of that which fits 390 points, so the date and the day arrows go to a top bar, the
views go to a bottom tab bar where a thumb can reach them, and the rest goes into an overflow
sheet. Overlays become bottom sheets for the same reason: a centred panel puts its buttons where
the hand is not.

Interaction changes on touch, not on width. Anything that only appeared on hover is always visible
instead, because a finger cannot hover and an affordance nobody can reach is not an affordance.
Dragging out a new event waits for a long press, because the alternative is that every tap on an
empty afternoon starts creating something. A tablet gets these and keeps the week grid; a narrow
desktop window gets the layout and keeps its mouse behaviour.

Navigation still moves one day at a time. A swipe is one day, never a week.

The week view survives on a phone rather than being hidden, because an overview has value even at
fifty points a column, but it is an overview: no times on the blocks, one letter for the day name,
and tapping a day header drops into that day. The day view is what a phone opens on.

What does not change is the premise. The day still fits without scrolling, the grid still owns
what is left after the two bars, and there is still no month view.

## Creating an event

Press `c` or `Cmd-K` and type. `lunch with sam tue 1pm 45m` creates a 45-minute event on
Tuesday. The parse is shown live underneath the input as you type, as a plain sentence with
the resolved date, time, duration and target calendar, so you can see what will be created
before you commit. If the parse is ambiguous the preview says so rather than guessing
silently.

`#work` targets a calendar, `at <place>` sets the location, a bare time range like `9-10am`
sets both ends. Anything the parser does not recognise stays in the title.

Dragging on the grid also creates: drag the range, type the title in place, Enter. Same event,
different mood.

## Meetings

Attendees and conference links are shown read-only on an event that has them, including who
has accepted. There is no RSVP flow, no availability finder and no scheduling links. That is
a deliberate cut, not an oversight, and it can be revisited once the calendar itself is good.

## Visual language

The token layer is lifted from margin unchanged: warm paper surfaces, ink and two softer ink
tones, hairline borders, a four-step type scale, three radii, one easing curve, light and dark
driven by `data-theme` on the root. The additions are grid-specific: hour and half-hour rule
colours, the now-line, the folded-band surface, and a set of eight muted calendar hues chosen
to sit on warm paper without shouting.

No CSS framework and no component library, same as margin. Hand-written CSS on top of tokens.
