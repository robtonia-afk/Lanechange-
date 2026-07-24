# Lane Change

A personal iPhone app that watches your GPS and tells you — out loud — when to
start working your way out of the HOV lane so you don't blow past your exit.

It's a web app, so there's no Xcode, no developer account, and no 7-day
re-signing. You host it once, add it to your home screen, and it behaves like
a normal app.

## What it does

1. You search for your exit and pick it from the results.
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
node --test tests/nav.test.mjs   # navigation math and alert logic
python3 tools/make_icons.py      # regenerate the app icons
npx http-server -p 8099 .        # serve locally (GPS needs localhost or HTTPS)
```

`nav.js` holds all the pure logic — distance, closing speed, ETA, stage
escalation, announcement text — and has no DOM dependencies, which is what
makes it testable in Node. `app.js` is the browser layer: geolocation,
geocoding, speech, wake lock, storage.

If you change any shell file, bump `CACHE` in `sw.js` or phones will keep
serving the old copy.

Geocoding is [Nominatim](https://nominatim.openstreetmap.org/), free and
key-less. It asks for no more than one search per keystroke-free submit, which
stays inside their usage policy for personal use.
