# Night Market

A private, invite-only marketplace for a friend circle. Members list items, chat, make trade offers and order delivery. Riders pick up and deliver, and a 4-digit code confirms the handoff. Payments are crypto only and happen directly between people: the app never touches money. It has no dependencies and calls no third-party services, apart from Google Fonts for the typefaces (the app works fine without them). You run your own copy with Node.js 18 or newer (https://nodejs.org), so each community owns its own market.

**Features:** accounts, invite-only joining, admin moderation (suspend members, approve riders), listings with photos and categories, buyer-seller chat, trade offers, delivery fee offers and counters, rider jobs, delivery code, ratings, problem reports.

## Run it

    cd night-market
    node server.js

Open http://localhost:3000 in Chrome.

The first account you create becomes the admin. Data is saved in `data.json` next to `server.js`. Back that file up, and do not share it (it holds password hashes).

## Let friends use it

By default the server only accepts connections from your own computer. To let friends on the same Wi-Fi connect:

    HOST=0.0.0.0 node server.js

They open `http://YOUR-COMPUTER-IP:3000`. On Windows PowerShell: `$env:HOST="0.0.0.0"; node server.js`.

For people outside your network, see Hosting for other people below.

## Invites and moderation

The market is invite-only. The very first account on a fresh server becomes the admin and needs no code. After that, every signup needs an invite code. Members create codes in the Invite tab (up to 3 unused at a time; the admin has no limit), and each code works once. The admin tab shows who invited whom, and the admin can suspend or restore any member. A suspended member is logged out, cannot log in, and their listings are hidden.

## Payments

Crypto only. There is no cash and no bank transfer in the app. Sellers can list the coins they accept (for example USDT, BTC), and buyer and seller agree the coin, amount and wallet address in chat. The app never touches money.

## Riders

By default anyone can apply to be a rider, and the admin approves them in the Admin tab. For open sign-up (no approval), start with `RIDER_SIGNUP=open`.

Riders only see the buyer's address after they accept a job. A job completes when the rider enters the buyer's 4-digit code.

## Delivery fees and the delivery code

When ordering, the buyer offers a delivery fee (in naira, paid to the rider in crypto). A rider can accept it, or counter with a different fee, and the buyer accepts or declines the counter. The buyer can change the fee or cancel the order until a rider is assigned. Riders save a wallet address in the Rider tab, and the buyer sees it once a rider is assigned, so the fee can be paid directly.

The buyer can name who is receiving the package and add a phone number. The rider sees the address, recipient and phone only after being assigned. Once a rider is assigned, the buyer sees a 4-digit delivery code to give to the person receiving the package, after they have checked the item. The rider has to type that code to finish the delivery. Five wrong codes lock the order and the admin has to step in.

## Hosting for other people

By default the app only runs on your computer. Friends on your Wi-Fi can join with `HOST=0.0.0.0` (see above). To let people anywhere join with just a link and an invite code, run it on an always-on machine with HTTPS (a small server or a Node hosting platform). Things to do when you host:

- Use a host with a **persistent disk**. Some platforms wipe their disk on every restart, which would erase `data.json` (all accounts, listings and orders).
- Serve it over HTTPS and start it with `COOKIE_SECURE=1`.
- **Create your admin account immediately.** The first account on a fresh server becomes the admin.
- Back up `data.json` regularly.

## Planned

Live maps (OpenStreetMap), an emergency button and check-ins for night deliveries, and alerts through a Telegram bot.

## Settings (environment variables)

- `PORT` (default 3000)
- `HOST` (default 127.0.0.1)
- `RIDER_SIGNUP` (`open` or leave unset for admin approval)
- `DB_FILE` (default `data.json`)
- `COOKIE_SECURE` (set to `1` when served over HTTPS)

## What this does not do

- **It does not move money or verify crypto payments.** It records the agreed price and marks the handoff. Buyer and seller settle payment themselves.
- Storage is one JSON file. That is fine for a friend circle; move to a real database (SQLite or Postgres) if it grows.
- Chats and orders refresh every 5 seconds, not instantly.
- No password reset yet. The admin would have to edit `data.json`.
- Each listing is a single item. When a delivery completes, it is marked sold.
- You are responsible for following local laws on trading goods, handling cash and crypto, and delivery.
