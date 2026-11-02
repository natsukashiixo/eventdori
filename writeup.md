# what this is
proof of concept calculator for a mobile game where you calculate how much resources (time or in-game resources aka boost drinks/gems) are needed to reach a certain amount of event points

# goal
calculate cost and time spent to reach a certain amount of points in a mobile game
optimize either for time, least resources spent or "balanced"

calculate available time from local device clock + event end time (manually set date, always ends at 11:00 UTC)

maths should run locally in users browser, responses should be cached there as well if possible

example output from similar project:

Event time left (mins)	1080
Natural Stamina	216
Natural points	2183
Extra stamina needed	43999
Left over stamina	1
Star Jewels spent	25870
Tokens spent	251226 (26.169 x9600)
Final Level	145
Normal Lives	3013
Event Lives	1066
Time Needed	203h57mins
Time Needed (Optimal)	156h1mins
Final event points	500809

# math things

----

boost costs
1 boost = 1 drink
1 boost = 10 gems

----

boost event point multipliers:
boosts, evenpoints*int
1, 8
2, 16
3, 24
4, 30
5, 37
6, 42
7, 46
8, 50
9, 53
10, 56

----

member event bonus formula
event points * (1+(total bonus percentage/100))

----

holopass formula
has holopass = event points * 2
no holopass = event points * 1

----

natural stamina regen:
1 per 45 minutes
caps at 10 without holopass
caps at 20 with holopass
can overfill to 99, any number above 20 turns natural stamina regen off

let user set stamina efficiency as float? put scary red text warning that natural boost regen is functionally 0 if user has set boost usage to >=7

----

song length bonus:
1+(song length bonus in percent/100)
highlight songs are always 50% unless the base song length bonus is >=51% then that wins

from mathgod discord user:
"`CEIL((lengthInSeconds - 50) * 0.3446 * boostFactor)`, where `boostFactor` is 1.3 on 1x boosts, 1.2 on 2x and 3x, and 1.0 otherwise."
"Or maybe `CEIL(CEIL((lengthInSeconds - 50) * 0.3446) * boostFactor)`? It might not even make a difference."

----

full event point multiplier formula probably:
(((ep * membonus)*song length bonus)*boosts)*holopass
need to normalize this down to just EP if we want user to re-calculate how drawing an event card/blooms would affect their ranking

----

# stretch goals
build average song length from event members highlight pool + main event song (50% chance to appear)
load team + bonus values from .hdbest team file ( looks b64 encoded not sure what it unwraps to )
automatically get event data ( https://api.holodori.best/api/events/list?region=us&language=jpn but has no information about which members are considered "active" for song selection )
automatically get new song data ( https://api.holodori.best/api/songs?lang=jpn and https://api.holodori.best/api/songs?lang=en but might be blocked by cloudflare bot protection , also no member information)
