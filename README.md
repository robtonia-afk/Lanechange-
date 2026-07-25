# Lane Change

A personal iPhone app that watches your GPS and tells you — out loud — when to
start working your way out of the HOV lane so you don't blow past your exit.

It's a web app, so there's no Xcode, no developer account, and no 7-day
re-signing. You host it once, add it to your home screen, and it behaves like
a normal app.

## What it does

1. You set your exit — search for it, pick it on a satellite map, or paste
   coordinates.
2. You tap **Start alerts** and mount the phone.
3. As you close in, it escalates:

| Stage | Default trigger | What it says |
|---|---|---|
| Heads up | 3 mi or 3 min out | "Heads up. *Exit* in 2.9 miles. Start working your way out of the H O V lane." |
| Move over now | 1.5 mi or 90 sec out | "Get out of the H O V lane now." |
| Last call | 0.3 mi or 30 sec out | "Take the exit." |
| At your exit | within 150 m | "You are at *Exit*." |
| Passed | confirmed past it | "You passed *Exit*." |

Each stage speaks once, chimes, and repaints the whole screen — green, amber,
orange, red — so it's readable in a glance from the cradle.

Distance **and** time are both checked, and whichever comes first wins. That
matters because a fixed distance is wrong at both ends: 1.5 miles is barely ten
seconds of warning in a fast-moving carpool lane, and it's several minutes when
traffic is crawling. The countdown uses how fast the gap to your exit is
actually closing, not raw speed, so a curving road or a slow lane doesn't throw
it off.

## Getting it on your phone

The app is plain static files. Any HTTPS host works; GitHub Pages is the least
effort:

1. Push this branch and merge it to your default branch.
2. Repo **Settings → Pages → Source: Deploy from a branch**, pick the branch and
   the `/ (root)` folder. (You can point Pages straight at
   `claude/hov-lane-exit-alerts-eds0za` if you'd rather not merge yet.)
3. Wait for the green check, then open `https://<you>.github.io/lanechange-/` in
   **Safari on the iPhone**.
4. Share button → **Add to Home Screen**.
5. Launch it from the home screen icon and tap **Start alerts** once so iOS
   prompts for location. Choose **Allow While Using**.

HTTPS is required — GPS is disabled on plain `http://` — which Pages gives you
for free. It must be Safari for the install step; Chrome on iOS can't add to the
home screen.

## Buffer-separated carpool lanes (most of Southern California)

Where the HOV lane is separated by a painted buffer, you may only cross at
marked openings — and the opening is often a mile or more before your ramp.
Counting down to the exit warns you about the wrong landmark: by the time it
speaks, your opening can already be behind you.

So an exit can carry an optional **HOV lane opening**. Set one and the trip
runs in two legs:

1. **To the opening** — "Cross out of the H O V lane now. The opening is in
   0.2 miles." The ramp stays on screen underneath as context, so the numbers
   never look like they contradict the signs.
2. **To the ramp** — once you're through, it re-aims at the exit and says so:
   "You're out of the H O V lane. Exit 26 in 0.8 miles." From here it never
   mentions the carpool lane again, because you've already left it.

Leave the opening blank on continuous-access lanes — most of Northern
California, where you can cross whenever — and it behaves exactly as before.

Four ways to set it:

- **Pick on map** — opens a satellite map centred on where you are. Move the
  map under the crosshair and tap **Use this**. The break in the buffer
  striping is visible from above, so this is usually the fastest accurate way.

- **Look up in OpenStreetMap** — queries Overpass for mapped openings near the
  exit and offers what it finds, nearest first.
- **Use where I am now** — tap it as you pass the opening.
- **Paste coordinates** — the openings are plainly visible from above, so find
  the break in the buffer striping in any satellite view, drop a pin, and paste
  the numbers in.

### How the OpenStreetMap lookup works

It rests on one property of OSM: mappers split a way wherever the lane markings
change. So a segment whose carpool lane is tagged crossable *is* an opening in
the buffer, and its first node in the direction of travel is the point where
you may start moving right. No inference — it reads the geometry.

`change:lanes` lists one value per lane, left to right. The carpool lane is
taken from `hov:lanes` when mapped and assumed leftmost otherwise, which is how
California builds them. `not_left` counts as crossable — it forbids only a move
to the left, and you are going right — while `not_right` is the value that
actually pins you in.

Divided highways carry each direction as its own way, metres apart, so position
cannot tell them apart. Direction can: a way whose heading points towards the
exit is your carriageway, and the other is dropped.

Two caveats, both real:

- **Coverage is patchy.** `change:lanes` is a niche tag. "No mapped openings on
  this stretch" is a normal answer, not a failure, and it leaves you with the
  other two methods.
- **OSM reflects when someone last mapped the road, not when Caltrans last
  restriped it.** Results are candidates the app never applies on its own.
  Confirm against the markings you can actually see.

Each lookup is cached per exit, so it is one Overpass request ever.

## Trying it without driving

Pick an exit, then tap **Simulate the drive in**. It replays a scripted 67 mph
approach through the same pipeline the real GPS feed uses, at 5x, so you get
every chime and spoken warning in about a minute from a parked car. A
"Simulation" pill marks the screen so it can't be mistaken for the real thing.

For a real-GPS test without a freeway, shrink the warning distances to
`0.25` / `0.15` / `0.12` mi with times of `20` / `12` / `5` sec, walk a few
hundred metres away, tap **Save the spot I'm at right now**, and walk back.
Keep every distance above `0.1` mi — the "at your exit" radius is a fixed 150 m,
and thresholds below it get swallowed.

## Before your first real drive

- **Turn off Auto-Lock** (Settings → Display & Brightness → Auto-Lock → Never)
  or at least set it long. The app asks iOS to keep the screen awake, and shows
  a warning pill if that request was refused.
- **Test the voice** with the button on the live screen, with the car's audio
  on. If your phone is on silent, spoken alerts still play but the chime may
  not — check it once so there are no surprises.
- **Do a dry run** on a route you know, and see whether 1.5 miles of warning is
  right for you. Four lanes in heavy traffic wants more; a two-lane road wants
  less. Adjust under **Warning distances**.

## Things worth knowing

- **It measures straight-line distance to the point you picked**, not distance
  along the road. On a freeway approach those are close, but the straight line
  is always the shorter one, so alerts land slightly *later* than the number
  suggests. Leave margin.
- **The screen has to stay on with the app in front.** Browser apps don't get
  background location on iOS. If you swipe away or the phone locks, alerts
  stop. This is the one real cost of not being a native app.
- **It doesn't know where the HOV lane's legal exit points are.** It tells you
  when your exit is close, based on your own lead-time settings. Where the
  stripe actually opens up is still yours to watch for.
- **Search needs a connection**, but every exit you pick is saved to the phone,
  so your regular commute works offline afterward. The app itself is cached and
  launches with no signal.
- It's a reminder, not a navigator. Watch the road and the signs.

## Picking the right point to search for

Exit ramps are often easier to find by what's at the end of them. Things that
work well:

- `I-405 exit 26` — OpenStreetMap tags many junctions with their exit number.
- `Wilshire Blvd & Sepulveda` — the cross-street at the bottom of the ramp.
- `34.0632, -118.2887` — paste coordinates directly and it skips the search.

Best of all: drive the route once and tap **Save the spot I'm at right now** at
the exact place you want the final warning. That's the only method that's
precisely right, and it's stored for every trip after.

Search results are ranked by relevance but anything more than 200 km away gets
pushed to the bottom, so a same-numbered exit in another state doesn't outrank
yours.

## Development

```sh
npm test          # navigation math and alert logic (20 tests)
npm run serve     # http://127.0.0.1:8099 — localhost counts as secure, so GPS works
npm run icons     # regenerate the app icons
npm run build     # bundle everything into dist/lanechange.html
```

`npm run build` inlines the CSS, both scripts, and the icon into a single
self-contained HTML file with no external requests — handy for AirDropping to
the phone or hosting somewhere that only takes one file. The multi-file version
at the repo root stays the source of truth; `dist/` is derived and gitignored.

`nav.js` holds all the pure logic — distance, closing speed, ETA, stage
escalation, announcement text — and has no DOM dependencies, which is what
makes it testable in Node. `app.js` is the browser layer: geolocation,
geocoding, speech, wake lock, storage.

If you change any shell file, bump `CACHE` in `sw.js` or phones will keep
serving the old copy.

Geocoding is [Nominatim](https://nominatim.openstreetmap.org/), free and
key-less. It asks for no more than one search per keystroke-free submit, which
stays inside their usage policy for personal use.
