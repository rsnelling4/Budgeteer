# Budgeteer

A small shared budget calendar: set up your recurring bills and income with
the date they hit each month, add one-off expenses/income as they come up,
and see your current balance, what's coming out this week, and your
projected end-of-week balance — all in real time, grouped by week, synced
live between you and your partner behind a shared 5-digit passcode.

It's a static site (plain HTML/CSS/JS) that reads and writes data to a free
Firebase project, so it can be hosted on GitHub Pages with no server to run
or pay for.

## 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**. Name it anything (e.g. "budgeteer"). You can decline Google Analytics.
2. Once created, click the **web** icon (`</>`) to register a new web app. Give it any nickname. You don't need Firebase Hosting.
3. Firebase will show you a `firebaseConfig` object. Copy those values into [js/firebase-config.js](js/firebase-config.js) in this project, replacing the placeholders.

## 2. Turn on Authentication

1. In the Firebase console, go to **Build → Authentication → Get started**.
2. Enable the **Email/Password** sign-in provider.
3. Go to the **Users** tab and click **Add user**. Use the email from `SHARED_EMAIL` in `js/firebase-config.js` (default `household@budgeteer.local` — it's just a username, not a real inbox, so any made-up address works).
4. For the password, use your 5-digit passcode **with the salt prefix added**: if `PASSCODE_SALT` is `bg-` (the default) and your passcode is `13579`, the password you set here is `bg-13579`. This is what makes your 5-digit code work as a password even though Firebase requires 6+ characters.
5. To change the passcode later, edit this user's password in the Firebase console (same `bg-` + 5 digits rule).

If you want your partner to have their own login instead of sharing one, you can add a second user here with a different password — both accounts will see the same data, since access is granted to *any* signed-in user (see step 3).

## 3. Turn on Firestore and lock it down

1. In the Firebase console, go to **Build → Firestore Database → Create database**. Choose any region close to you, and start in **production mode**.
2. Go to the **Rules** tab and replace the contents with what's in [firestore.rules](firestore.rules) in this project, then click **Publish**.
   This ensures only someone signed in with your passcode can read or write your budget data — the config values in `firebase-config.js` are not secret by themselves.

## 4. Run it locally to test

You can't just double-click `index.html` (browsers block ES module imports from `file://`). Instead, from this folder run a tiny local server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` and enter your 5-digit passcode.

## 5. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial Budgeteer app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then in your GitHub repo: **Settings → Pages → Source: Deploy from a branch → Branch: main, folder: / (root)**. Your app will be live at `https://<your-username>.github.io/<your-repo>/` within a minute or two.

Share that URL with your partner along with the passcode.

## Using the app

- **Set up recurring bills & income (⚙ → Recurring bills & income)**: for each one, give a name, amount, and the day of the month it's due or received (e.g. Rent, $1716, day 1). The app automatically generates a dated entry for that item every month (2 months back, 3 months ahead) and keeps generating further out over time — pre-seeded with a typical bill list you can edit or delete.
- **Add a one-off item**: for anything that isn't recurring (a car repair, extra income, a gift), use the "Add an item" card — set description, amount, expense/income, and date.
- **Mark things paid**: every entry — recurring or one-off — has a checkbox. Check it once the money actually leaves or lands in your account.
  - **Current balance** (top of the app) only counts items you've checked as paid — it's your real, right-now bank balance.
  - **Projected end of week** counts everything scheduled for that week whether or not it's checked yet — so you can see where you'll land once this week's bills clear.
  - **Coming out this week / Coming in this week** show the totals scheduled for the current week.
- **Edit an amount** directly in the ledger (e.g. if a bill comes in different than usual) — it saves on blur/enter and immediately recalculates every projection.
- **Weeks**: everything is grouped Monday–Sunday like a calendar, oldest to newest, each showing its projected ending balance; today's week is labeled "this week".
- **Settings (⚙)**: also set your starting balance (today's real balance, before you started marking things paid).
- **Lock (🔒)**: signs out and shows the passcode screen again.

## Notes on privacy

The 5-digit passcode is a **speed bump**, not bank-grade security — someone who
guesses it, or who convinces Firebase to reset the account, could read your
budget. It's enforced server-side by Firebase Authentication + the Firestore
rule above (not just hidden in the page), so casual visitors and search
crawlers can't get in, but treat this the way you'd treat a shared notes app,
not a bank account.
