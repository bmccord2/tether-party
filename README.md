# Tether Party

Offline multiplayer party games for phones (iPhone + Android). Phones talk directly over WebRTC data channels on a shared hotspot/Wi-Fi. No internet and no server are needed while playing.

## Games
- **Trivia Blitz**: Kahoot-style. 130 built-in questions; faster correct answers score 500–1000.
- **Imposter**: everyone but the imposter sees a secret word. Players give clues out loud, then vote. A caught imposter can still win by guessing the word.
- **Quick Draw**: reaction race. Each phone times itself locally, so network lag doesn't affect results.

## Hosting (one time)
The page has to be served over HTTPS so the camera and the offline cache work. GitHub Pages is the easiest option:
1. Push this folder to a repo, then go to Settings → Pages → Deploy from branch (root).
2. Open the URL once on each phone while online, then use Share → **Add to Home Screen**. The service worker caches everything, so it launches offline after that.

## Playing
1. One phone turns on its personal hotspot and the others join it. (Or everyone joins the same Wi-Fi; guest Wi-Fi often blocks phone-to-phone traffic.)
2. Host: **Host a game** → **+ Add player** → shows an invite QR.
3. Joiner: **Join a game** → scans it → shows a reply QR → host scans that. Repeat for each player.
4. Keep screens on. A phone that locks or switches apps drops its connection.

## How it works
- Star topology: the host is authoritative and sends each phone a "view" object, and each phone renders it. Game logic lives only in `Trivia/Imposter/Reaction()` in app.js.
- Signaling has no server. The SDP is shrunk to about 100 characters (ufrag, pwd, DTLS fingerprint, host candidates) so it fits in a small QR code, then rebuilt on the other side (`pack`/`unpack`).
- The camera is opened before the offer or answer is created. Browsers expose real LAN IPs as ICE candidates once camera permission has been granted, which avoids relying on mDNS (.local) resolution.
- A text-code fallback (copy/paste) is under "Can't scan?".

## Adding a game
Write `function MyGame(opts)` that returns `{start, act(pid,a), view(pid), leave(pid), stop}`, register it in `GAMES`, and add renderers in `R` for its view kinds (`k`).
