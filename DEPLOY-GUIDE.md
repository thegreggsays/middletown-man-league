# Getting MiddletownManLeague.com Online

Written for someone who doesn't write code. No command line, no programming.
Everything here is filling in web forms and clicking buttons.

**Time:** about 45 minutes, spread across a few sittings.

---

## The short version

You need three accounts and one domain name:

| | What it does | Cost |
|---|---|---|
| **GitHub** | A folder in the cloud that holds your files | Free |
| **Railway** | The computer that runs your website | ~$5/month |
| **Cloudflare** | Where you buy MiddletownManLeague.com | ~$10/year |
| **Yahoo** | Permission to read your league's data | Free |

You upload files to GitHub. Railway watches that folder and turns it into a
website. Cloudflare points your domain at it. Yahoo access comes last.

---

## Do it in this order

1. **GitHub** — upload the files
2. **Railway** — get the site running
2.5. **Storage** — so a deploy can't wipe the votes, dues and rankings
3. **Cloudflare** — hook up MiddletownManLeague.com
3.5. **Google Sheet** — so the site updates when you update the sheet
4. **Yahoo** — apply for access (needs your live website to exist first)
5. **Turn it on** — one small edit once Yahoo approves you

> ### Already running the site? Do Part 2.5 before your next push.
>
> Railway rebuilds your app folder from GitHub every time you deploy. The
> league database sits in that folder, so a deploy replaces it with an empty
> one — taking the votes, the dues, the parlay picks and any rankings you
> uploaded through the site with it.
>
> **Part 2.5 moves it somewhere deploys don't reach.** Back up *before* you
> push — visit your site's address with `/backup?code=YOURCODE` on the end and
> keep the file. The data that's live right now exists nowhere else, and the
> push is what destroys it. After the push you upload that file at `/restore`.
>
> Marc's rankings are the exception: those are image files in GitHub now, so
> they come back on their own.

**Steps 1–3.5 get you a fully working site today**, including live keeper data
straight from your spreadsheet. Steps 4–5 add the Yahoo features later.

> **You do not need Yahoo for the site to be useful.** Keepers, Keeper Costs,
> Draft Results, Pick Trades, and Summary all run off your spreadsheet. Only
> Activity, League History, and live Standings wait on Yahoo.

---

## Before you start

Unzip `mmlfl-deploy.zip`. Everything goes in one folder, keeping the layout
exactly as it comes out of the zip:

- `index.html` — the website
- `yahoo-proxy.js` — the part that talks to Yahoo
- `league-sheet.js` — the part that reads your Google Sheet
- `package.json` — a list of ingredients Railway needs
- `team-key.csv` — which Yahoo team name belongs to which owner
- `activity.csv` — the Yahoo transaction log, pasted in
- `power-rankings/` — a folder of Marc's rankings, one image per week
- `.gitignore` — keeps the database and your Yahoo keys out of GitHub
- `DEPLOY-GUIDE.md` — this guide

Don't rename anything, and leave `power-rankings` as a folder rather than
pulling the images out next to everything else. The names and the layout are
what the code looks for.

`.gitignore` starts with a dot, so your computer may hide it. It's in the zip
either way — if you don't see it, that's your computer hiding it, not a
missing file. Turn on "show hidden files" if you want to confirm.

---

# Part 1 — GitHub

*GitHub is just cloud storage. Railway needs somewhere to read your files from.*

## Step 1. Make an account

Go to **github.com**, click **Sign up**. Free.

## Step 2. Make a folder for your project

GitHub calls these "repositories." It's a folder.

1. Click the **+** in the top-right → **New repository**
2. **Repository name:** `middletown-man-league`
3. Leave it set to **Public**
4. Check the box for **Add a README file**
5. Click **Create repository**

> **"Public" means anyone can see these files — is that okay?** Yes. There's
> nothing private in them. Your Yahoo password and access keys never go in here;
> they go somewhere else entirely, in Part 4.

## Step 3. Upload your files

1. Click **Add file** → **Upload files**
2. Drag in **`index.html`**, **`yahoo-proxy.js`**, **`league-sheet.js`**, and **`package.json`**
3. Scroll down, click **Commit changes**

> **"Commit" just means save.** GitHub uses odd words for ordinary things.
> Whenever you see "commit," read it as "save."

You should now see your four files listed. Part 1 done.

---

# Part 2 — Railway

*Railway is the actual computer that runs your site, 24 hours a day.*

## Step 4. Sign up and add payment

1. Go to **railway.app**
2. Click **Login** → **Sign in with GitHub** (use the account you just made)
3. Go to **Account Settings** → **Billing**
4. Add a card and choose the **Hobby plan** — $5/month, which includes $5 of
   usage
5. While you're there, set a **spending limit of $10**

> **What will this actually cost?** A small site like this typically uses $3–5
> a month, so the included credit usually covers it. The spending limit is a
> safety net so you can't get a surprise bill.

## Step 5. Point Railway at your files

1. Railway dashboard → **New Project**
2. Choose **Deploy from GitHub repo**
3. Approve access if it asks
4. Pick `middletown-man-league`

Railway starts building. Give it two or three minutes.

> **Why this should just work:** the `package.json` file you uploaded tells
> Railway exactly what to install and how to start. That's the whole reason it's
> there — it removes the step where you'd otherwise have to type in settings.

## Step 6. Get your web address

1. Click your service (the box in the middle of the screen)
2. Go to **Settings** → scroll to **Networking**
3. Click **Generate Domain**

Railway gives you an address like
`middletown-man-league-production.up.railway.app`.

**Open it.** Your site should load. It's live on the internet right now.

> Bookmark this address — you'll need it again in Part 4.

---

# Part 2.5 — Make Your Data Survive Deploys

**Do this before your second deploy.** Ten minutes, and skipping it is how you
lose things.

## Why

Some of what the site holds doesn't come from the Google Sheet. The votes, the
dues, the parlay picks and any rankings uploaded through the site live in a
database file the server writes as it goes.

That file sits inside your app folder — and Railway rebuilds the app folder
from GitHub on every deploy. New copy of the folder, no database in it. Push
code on Tuesday and Monday's votes are gone.

The fix is to keep the database somewhere Railway leaves alone. Railway calls
that a **volume**: a bit of disk that survives rebuilds.

## Step A. Back up what's there now

In your browser, go to your site's address with this on the end:

```
/backup?code=6699
```

So: `https://middletownmanleague.com/backup?code=6699` (use your real
`ANNOUNCE_CODE` if you changed it from 6699).

A file downloads. Put it somewhere you'll find it. That's your safety net for
everything below — do this first, even though nothing has gone wrong yet.

## Step B. Tell the server where to keep the database

In Railway: click your service → **Variables** tab → **New Variable**.

| Name | Value |
|---|---|
| `DATA_DIR` | `/data` |

## Step C. Give it the disk

Same service → **Settings** tab → find **Volumes** → **Add Volume**.

Set the mount path to:

```
/data
```

It has to match what you typed in Step B exactly. Save.

## Step D. Check the volume took

Railway restarts the service. Open the **Deployments** tab and look at the log.
Near the top you want:

```
[data] database: /data/league.db
```

If it says `[data] database:` followed by any path that isn't `/data/`, the
variable or the volume didn't take. Go back and check both before continuing.

**The database will be empty at this point, and that's expected.** Railway
throws the old container's disk away when it builds a new one, so the database
that was running before this change is already gone — it only ever existed
inside the running container, never in GitHub. That's what the backup in Step A
was for. Step E puts it back.

## Step E. Put your data back

Go to your site's address with this on the end:

```
/restore
```

So: `https://middletownmanleague.com/restore`. It's a plain page with two
boxes — it isn't linked from the site, you have to type the address.

1. Enter your code (the same one you use to post)
2. Choose the file you downloaded in Step A
3. Click **Restore**

It checks the file is really a backup from this site, then restarts. Wait about
a minute and reload the main page — the dues, parlay picks and board posts are
back.

To confirm, the deploy log will show:

```
[data] restored the database from an uploaded backup
[data] database: /data/league.db
```

**This is a one-time thing.** Once the volume is mounted, deploys stop touching
the database and you never need to do this again — unless you move hosts.

> **Keep taking backups.** `/backup?code=...` every month or so, ten seconds,
> and it's the only copy of the dues and board that exists outside Railway.
> Now that `/restore` exists, a backup is actually worth something.

---

# Part 3 — Your Domain Name

*Now let's replace that long ugly address with MiddletownManLeague.com.*

## Step 7. Buy the domain

1. Go to **dash.cloudflare.com** and make a free account
2. Left sidebar → **Domain Registration** → **Register Domain**
3. Search for `middletownmanleague.com`
4. Buy it — about **$10 for the year**

> **Say no to extras.** You don't need hosting, email, or an SSL certificate.
> Railway handles the security padlock automatically and for free.

> Capital letters don't matter. `MiddletownManLeague.com` and
> `middletownmanleague.com` are the same thing. Write it however looks best when
> you share it with the guys.

## Step 8. Tell Railway about your domain

1. Railway → your service → **Settings** → **Networking**
2. Click **Custom Domain**
3. Type `middletownmanleague.com` and confirm

Railway shows you a **CNAME record** — it'll look something like
`abc123.up.railway.app`. **Leave this screen open**, you're about to copy that
value.

## Step 9. Connect them at Cloudflare

1. Cloudflare → click **middletownmanleague.com**
2. Left sidebar → **DNS** → **Records**
3. Click **Add record** and fill in:
   - **Type:** `CNAME`
   - **Name:** `@`
   - **Target:** paste the value Railway showed you
   - **Proxy status:** **click the orange cloud so it turns grey** and says
     *DNS only*
4. **Save**

Then add a second one so `www.middletownmanleague.com` works too:

- **Type:** `CNAME`
- **Name:** `www`
- **Target:** the same value
- **Proxy status:** grey again — *DNS only*
- **Save**

### Read this part twice — the orange cloud

Cloudflare turns on a feature called "Proxied" by default, shown as an **orange
cloud** icon. It routes your visitors through Cloudflare's computers first.

That fights with Railway, which is already handling your site's security
certificate. The result is an error page or a site that reloads forever.

**Both records must show a grey cloud that says "DNS only."** If you already
saved them orange, just click the cloud icon to toggle it. No need to delete
anything.

This is the single most common thing that goes wrong. It looks like a broken
website but it's a one-click fix.

## Step 10. Wait a few minutes

Go to **MiddletownManLeague.com**. It may not work immediately — the internet
takes a little while to learn where your domain points.

With Cloudflare it's usually **under 5 minutes**. An hour is still normal.

When it loads, you're done with the hard part. Share it with the league.

---

# Part 3.5 — Connecting Your Google Sheet

*Do this right after Part 2. It has nothing to do with Yahoo and works today.*

## What this gets you

Right now the Keepers, Keeper Costs, Draft Results, and Pick Trades tabs show a
**snapshot** — a copy I made of your spreadsheet. Editing your sheet doesn't
change them.

After these two steps, the site re-reads your sheet every few minutes. Declare a
keeper in the sheet, and the website shows it. No more sending me files.

## Step A. Let Google share the sheet

1. Open your keeper Google Sheet
2. Click **Share** (top right)
3. Under **General access**, change *Restricted* to
   **Anyone with the link**
4. Leave the role as **Viewer** — nobody can edit it
5. **Done**

> **Is that safe?** It means someone would have to know the exact long web
> address to see it. It's fantasy football keeper data, and it's about to be on
> a public website anyway. Nobody can change anything — view only.

## Step B. Tell Railway where the sheet is

Look at your sheet's web address. It looks like this:

```
docs.google.com/spreadsheets/d/1wm-34BeOzvvCLOwYulwK7R2hA96Fziv3rTpu01V6nZs/edit
                              └──────────── this long part ────────────┘
```

1. Copy that long middle chunk
2. Railway → your service → **Variables** → **New Variable**
3. Name: `SHEET_ID`
4. Value: paste it
5. Save

Railway restarts on its own. Reload your site — the badge at the top of the
Keepers tab should now say **"Live from the league Google Sheet."**

## If a tab still shows old data

The site keeps its built-in snapshot as a backup, so if it can't reach the sheet
it shows that instead of going blank. To check what's happening, visit:

```
https://middletownmanleague.com/league-data
```

- **A wall of text with player names** — it's working
- **`"SHEET_ID is not set"`** — redo Step B
- **`"not shared publicly"`** — redo Step A

## Two things to know about how it reads the sheet

**Tab names matter.** It looks for tabs named exactly `2026-2027`,
`2025-2026`, and `2024-2025`. If you rename or add a season tab, tell me and
I'll update it.

**Colours don't survive.** Google only hands over the text of your sheet, never
the red and green shading. So "1st year / 2nd year" is worked out by comparing
seasons instead: if you kept a guy last year and you're keeping him again,
that's year two. You don't need to colour anything for the site to work — keep
doing it for your own reference if you like.

---

# Part 4 — Yahoo Access

*Do this only after MiddletownManLeague.com is loading.*

## Why it had to wait

Yahoo's application form requires a **website address**, and won't let you
submit without one. That's why the site came first. Now you have a real address
to give them — and whoever reviews it can click through and see a genuine league
site, which helps.

## Step 11. Fill out Yahoo's form

You'll find it on Yahoo's developer page. Here's what each box is really asking:

| The box says | Put this |
|---|---|
| Name | Your real name |
| Business Title | You're not a business. `League Commissioner` is fine |
| Email Address | The one attached to your Yahoo Fantasy account |
| Phone Number | Yours |
| Business Name & Address | Your own name and home address. Regular people apply for this all the time |
| Consumer-Facing Product or App Name | `Middletown Man League` |
| Brief Company Description | *Private fantasy football league site for a single 12-team Yahoo league. Not a company, not a commercial product.* |
| Website URL | `https://middletownmanleague.com` |
| Describe Your Intended Use Case | See the box below |
| Expected Users | Pick the smallest option. You have 12 guys |
| Client ID | Leave blank |

### For "Intended Use Case," write something like this

Yahoo's own instructions say applications should identify the product, the data
needed, and who'll use it — *including where access is limited to personal or
single league use*. They're telling you that "one private league" is a perfectly
good answer. Don't dress it up as a business.

> Private website for a single 12-team Yahoo fantasy football league I
> commission. Read-only access to one league: standings, rosters, transactions,
> and past season results. Used to display keeper eligibility and costs under
> our league's custom keeper rules, and to keep a permanent archive of adds,
> drops, and trades, since Yahoo only shows recent transactions. Roughly 12
> users — the league members. Not commercial, no public signup, no
> redistribution of Yahoo data.

Every word of that is true about what you built.

## Step 12. Submit, then wait

Yahoo reviews these by hand. I don't know their current turnaround time, and
anyone who gives you a specific number is guessing. Plan on days, and watch the
email address you gave them.

**If you get turned down**, it's usually fixable — make the use case more
specific, and make sure you said it's private and non-commercial. You can
reapply.

---

# Part 5 — Turning On the Yahoo Features

*Once Yahoo emails you a Client ID and Client Secret.*

## Step 13. Put your Yahoo keys into Railway

1. Railway → your service → **Variables** tab
2. Click **New Variable** and add each of these, one at a time:

| Name | Value |
|---|---|
| `YAHOO_CLIENT_ID` | from Yahoo's email |
| `YAHOO_CLIENT_SECRET` | from Yahoo's email |
| `YAHOO_REDIRECT_URI` | `https://middletownmanleague.com/auth/callback` |
| `LEAGUE_KEYS` | see below |
| `POLL_MINUTES` | `15` |
| `SCORING` | `HALF` |
| `BOARD_PASSWORD` | a word the league shares, e.g. `cleat` — optional, see below |
| `ANNOUNCE_CODE` | `6699` — the code for announcements and proposing rule changes |
| `VOTE_PASS_THRESHOLD` | `7` — yes votes needed to pass a rule change |
| `LEAGUE_OWNERS` | the 12 names, comma-separated — used for the voting dropdown |

> **This is where your secrets live — not GitHub.** Railway keeps these private.
> Never paste your Client Secret into a file you upload to GitHub.

### About ANNOUNCE_CODE

The announcement at the top of the page, and proposing a rule change on the Vote
tab, both use this code. It's set to `6699`. Give it to whoever should be able to post
announcements — commissioner, co-commissioner, whoever.

Setting it as a variable in Railway matters: the code gets checked on the
server, so it never appears in the website's page source. If you skip the
variable it still defaults to `6699`.

To change it later, edit the variable in Railway. No file changes.

> **Be realistic about what this protects.** A four-digit code keeps honest
> people honest — it stops a random visitor from posting nonsense. It is not a
> real password, so don't reuse it anywhere that matters.

### About BOARD_PASSWORD

Your site is public, so anyone who finds the address could post on the message
board. Setting `BOARD_PASSWORD` means people have to type a shared word before
posting — reading stays open to everyone.

Pick anything and text it to the guys. Leave the variable out entirely if you'd
rather not bother.

You can also change `BOARD_RETENTION_DAYS` if six months isn't right. Default is
`180`.

### What goes in LEAGUE_KEYS

Yahoo gives your league a new ID number every season. Open your league in Yahoo
Fantasy and look at the web address — there's a number in it. Your key is
`nfl.l.` followed by that number.

List them oldest season first, separated by commas, no spaces:

```
nfl.l.111111,nfl.l.222222,nfl.l.333333
```

More seasons means more league history on the site. If you only have this year's
handy, start with one and add older ones later.

**One more thing:** go back to your Yahoo developer app settings and make sure
the redirect address there says exactly
`https://middletownmanleague.com/auth/callback`. It has to match what you typed
into Railway, character for character, or the next step will fail.

## Step 14. Give Yahoo permission — one time only

In your browser, go to:

```
https://middletownmanleague.com/auth/start
```

Yahoo asks you to log in and approve. Say yes. You'll get a confirmation
message.

**You never do this again.** The site keeps its own access renewed from here on.

## Step 15. Check that it's working

Go to:

```
https://middletownmanleague.com/health
```

You'll see a line of text with some numbers in it. Look for:

- **`"authorized": true`** — Step 14 worked
- **`"archived": 0`** — how many transactions have been saved. Zero right after
  setup is normal. Check back in a few days and it should be climbing

## Step 16. Nothing to flip

Earlier versions of this guide had you hand-edit a line in `index.html` to turn
the server features on. That step is gone — the site now detects its own server
automatically.

That also means the Board, Vote, News and Google Sheet tabs have been working
since the moment the site went live on Railway. They never needed Yahoo. Only
Activity, League History and live Standings were waiting, and those switch on by
themselves once Step 14 succeeds.

---

# Changing the site later

If I send you an updated `index.html`:

1. GitHub → your repository → **Add file** → **Upload files**
2. Drag in the new file (it replaces the old one — that's fine)
3. **Commit changes**

Railway rebuilds automatically within a minute or two. That's the whole process.

---

# Keeping it current during the season

Three things you'll update as the season runs. All three are the same move:
replace a file in GitHub, and Railway redeploys itself.

## Standings and rosters — the Google Sheet

Nothing to upload. Edit the sheet and the site follows within five minutes.

## Marc's power rankings — the `power-rankings` folder

Save the image named for its week and drop it in the folder:

```
power-rankings/week-5.jpg
power-rankings/week-6.jpg
```

Anything you type after the week number becomes the caption underneath it on
the site, which is why one of them is:

```
power-rankings/week-3 Chinese Food Special Edition.jpg
```

That shows as **Week 3** with *"Chinese Food Special Edition"* below it. No
caption wanted? Just `week-5.jpg`. Works with `.jpg`, `.jpeg`, `.png`, `.gif`
and `.webp`.

To put one up without touching GitHub, the upload button on the site still
works and still needs the code. If a week has both an uploaded image and a file
in the folder, the folder wins and you won't see it twice.

One thing the folder can't do: you can't delete those from the site. Remove the
file from GitHub and push instead. Uploaded ones still delete normally.

## Transactions — `activity.csv`

When you want the Activity tab caught up:

1. Open the transactions page on Yahoo
2. Select the whole log and copy it
3. Paste it into a spreadsheet, so each line lands in its own row
4. Export that as CSV, name it `activity.csv`
5. Upload it to GitHub, replacing the old one

`team-key.csv` only changes if somebody renames their Yahoo team. Two columns,
Yahoo team name on the left, owner on the right — edit it right in GitHub if
that happens.

> **These two CSVs beat the Google Sheet.** If a tab named `Team Key` or
> `Activity` exists in the sheet as well, the CSV in GitHub is what gets used.
> You only need one, and the CSV is the one to keep.

---

# When something goes wrong

**Railway build failed**
Click the failed deploy to see the log. Most likely a file didn't get uploaded —
check that every file from the zip is in your GitHub repository, and that
`power-rankings` is still a folder with the images inside it.

**The votes, dues or parlay picks emptied out after a deploy**
The database wasn't on a volume. Do Part 2.5, then upload your most recent
backup at `/restore`. If you never took a backup, that data is gone — there is
no copy anywhere else. Do Part 2.5 now so it can't happen a second time.

**`/restore` says "That is not a database file"**
You picked the wrong file. It wants the one that came out of `/backup`, which
downloads with a name like `league-backup-2026-10-10.db`. A CSV, a zip or a
screenshot won't work.

**`/restore` says "That database is not from this site"**
It's a real database but not this site's — wrong file, or one from some other
project. Find the right backup.

**I clicked Restore and the site won't load**
Normal for up to a minute. The server exits on purpose so Railway restarts it,
and the restore is applied as it comes back up. Give it 60 seconds and reload.
If it's still down after that, check the deploy log for `[data] restored`.

**Marc's rankings don't show up**
Check the file name. It has to start with the word `week`, then the number:
`week-5.jpg` works, `Week5.jpg` and `week5.jpg` work, `rankings-5.jpg` does
not. Also check the folder is named `power-rankings` exactly, and that the
images are inside it rather than loose in the main folder.

**The Activity tab is empty**
`activity.csv` is missing from the repository, or it got saved as something
other than CSV. Excel will happily name a file `.csv` while saving it as a
workbook — use "Save As" and pick CSV explicitly.

**A keeper's cost looks wrong**
Almost always a name typed differently in two places on the sheet — the draft
board might say "CMC" while the roster says "Christian McCaffrey." Visit
`middletownmanleague.com/league-data` and look for `notFoundOnDraftBoard`. That
list shows every player the site couldn't match to a draft pick. Genuine waiver
pickups belong there; a drafted player showing up is a typo. Send me the name
and I'll teach the site that nickname.

**MiddletownManLeague.com won't load after an hour**
It's the orange cloud, nine times out of ten. Cloudflare → DNS → Records, and
make sure both entries say **DNS only** with a grey cloud, not **Proxied** with
an orange one.

**"Too many redirects" or a certificate warning**
Same cause. Grey cloud.

**Railway address works but your domain doesn't**
The CNAME value at Cloudflare doesn't match what Railway gave you. Copy it again
from Railway → Settings → Networking.

**`/health` says `"authorized": false`**
Do Step 14 again. If it still fails, the redirect address in Railway and the one
in your Yahoo developer settings don't match exactly. Compare them
character by character, including the `https://` at the front and
`/auth/callback` at the end.

**A server-powered tab says it can't reach the server**
Visit `middletownmanleague.com/health` in a browser. A line of text with numbers
means the server is fine — for Activity and History the remaining issue is Yahoo
authorization (see `authorized: false` above). If that page doesn't load at all,
the server is down; check Railway's **Deployments** tab.

**Changes aren't showing up**
Check Railway's **Deployments** tab — the newest should say "Success." Then
refresh hard: **Ctrl+Shift+R**, or **Cmd+Shift+R** on a Mac.

---

# What it costs

| | |
|---|---|
| GitHub | Free |
| Railway | ~$5/month |
| Domain | ~$10/year |
| Yahoo | Free |

Roughly **$70 a year**, or about $6/month all in. Split twelve ways that's under
$6 per guy for the season.
