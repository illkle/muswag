# Notes for agents

## Showing UI changes to someone on another machine

The app is an Electron window on the machine you run on, which the person you work with may not be sitting at.
To let them see and click the UI, run the dev app with its dev bridge on and share the dev server over Tailscale.
They open the URL in Chrome and get the live renderer, with hot reload as you edit.

### In the main checkout

```
MUSWAG_DEV_BRIDGE_PORT=5174 pnpm dev
tailscale serve --bg --https=8443 http://127.0.0.1:5173
tailscale serve status
```

`tailscale serve status` prints the URL to hand over. The mapping outlives the dev app and reboots, so check
whether it already exists before adding it.

### In a worktree

Every checkout that runs at the same time needs three ports of its own: the dev server, the bridge and the
Tailscale HTTPS port. `tailscale serve status` lists the HTTPS ports that are taken; leave the mappings you did
not create alone.

A new worktree has no dependencies, no `.env` and an empty library, so set it up first. With `$MAIN` as the
path of the main checkout:

```
pnpm install
cp "$MAIN/.env" .env
sqlite3 "$MAIN/apps/desktop/dev-library.db" ".backup apps/desktop/dev-library.db"
```

The `.backup` copy brings over the login and the synced library, and is safe while the main checkout's app
is running. Then, with ports that are free:

```
MUSWAG_DEV_PORT=5183 MUSWAG_DEV_BRIDGE_PORT=5184 pnpm dev
tailscale serve --bg --https=8444 http://127.0.0.1:5183
```

When the worktree is done with, stop the dev app and remove its mapping: `tailscale serve --https=8444 off`.

### What to keep in mind

- The browser drives the real app. Playing a track starts mpv on this machine, and playlist edits reach the
  Subsonic server.
- Checkouts running side by side have their own library, queue and player, but share the cover cache and the
  player settings.
- The bridge works only in development and only with `MUSWAG_DEV_BRIDGE_PORT` set. It listens on loopback
  and runs any command for whoever reaches it, so share it only inside the tailnet: `tailscale serve`, never
  `tailscale funnel`.
- The code is in `apps/desktop/src/main/dev-bridge.ts` and `apps/desktop/src/renderer/data/dev-bridge.ts`.
