# Word Cypher

A crossword tile game where every word in the English dictionary counts, and so does Urban Dictionary slang. Slang words score **+5 street cred**. Play the CPU, or open a room and play friends online (2–4 players) with a 5-letter code. No accounts: everyone gets a random guest name they can change.

**Play:** https://YOUR-USERNAME.github.io/word-cypher/ (after you turn on GitHub Pages, below)

## Put it online with GitHub Desktop

1. In GitHub Desktop: **File → Add local repository**, pick this folder, and click **create a repository** when it says the folder isn't one yet. Keep the name `word-cypher` and click **Create repository**.
2. Click **Publish repository**, uncheck **Keep this code private**, and publish. This makes the repo on GitHub for you.
3. On github.com, open the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, **Save**.
4. After a minute or two the game is live at `https://YOUR-USERNAME.github.io/word-cypher/`.

To update later: change files, **Commit to main**, **Push origin**. Pages refreshes within a couple of minutes (hard-refresh the page if you still see the old version).

On iPhone, open the link in Safari, tap Share → **Add to Home Screen** to get it as an app icon.

## How online play works

- It's peer to peer, the same way PALISADE does it (PeerJS). The free PeerJS server only introduces browsers to each other; after that the host and guests talk directly.
- **The host's browser runs the game.** It holds the tile bag, checks every word and keeps score. Each guest is sent only their own tiles, so nobody can see other racks or the bag.
- **The host has to keep the tab open.** If the host's phone locks or they reload, guests see "Reconnecting…". When the host comes back and taps **Reopen room**, the same code and game come back and guests reconnect on their own.
- **Guests can drop and come back.** Their seat and tiles are kept; reopening the site shows **Rejoin**. If a guest is gone on their turn, the host can tap **Let the CPU play for them**; they take the seat back when they rejoin.
- Rooms hold up to 4 seats. The host can fill empty seats with Easy, Medium or Hard CPUs.
- Some strict networks (certain cellular or work Wi-Fi) block direct connections. Switching to normal Wi-Fi usually fixes it.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css` | The page and its look |
| `js/engine.js` | Word lists, scoring, and the CPU's move finder |
| `js/game.js` | Game rules: turns, swaps, end of game, what each player can see |
| `js/app.js` | Screens, board controls, solo play, and online rooms |
| `words.txt` | 273,000 words, one per line (see below) |
| `peerjs.min.js` | PeerJS 1.5.5, same version PALISADE uses |
| `dev/` | Word-list builder, the hand-picked slang list, and tests |

### Adding or removing words

`words.txt` has one word per line, lowercase, 2–15 letters:

- `word` is a regular dictionary word
- `*word` is Urban Dictionary slang (players can play it; the CPU won't)
- `!word` is well-known slang (players and the CPU can both play it)

To add slang, add a line like `!skrrt` anywhere in the file. Order doesn't matter. To ban a word, delete its line.

### Changing the online protocol

If you change the messages between host and guests in `js/app.js`, bump `PROTO` at the top of that file. Guests on an old cached copy then get told to refresh instead of breaking mid-game.

## Testing

- `node dev/core.test.js` plays a handful of 2–4 player CPU games and tries some cheating moves.
- To test online play without the public PeerJS server, run your own (`npx peerjs --port 9000 --path /myapp`) and open the game with `?peerhost=localhost&peerport=9000&peerpath=/myapp`. Invite links carry those settings along.
- In the browser console, `wordCypher.view` shows what this device can see.

## Credits

- Dictionary: [word-list](https://github.com/sindresorhus/word-list) by Sindre Sorhus (MIT)
- Urban Dictionary titles: [urban-dictionary-word-list](https://github.com/mattbierner/urban-dictionary-word-list) by Matt Bierner (MIT), filtered to commonly used entries, with names and slurs removed
- Networking: [PeerJS](https://peerjs.com) (MIT)
- Fonts: Bungee and Barlow from Google Fonts

Word Cypher isn't affiliated with Hasbro, Mattel or Urban Dictionary.
