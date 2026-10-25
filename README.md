# muswag

Music app for navidrome and other opensubsonic clients.

Core principles:

- sync based: stores local copy of metadata in sqlite. instant navigation always and fuzzy search that updates as you type.
- mpv backend: a stable core with wide format support.
- UI patterns familiar to spotify users.

Implementation details:

- Alpha state, I will change stuff and might break something.
- LLM's heavily used blah-blah-blah
- I use and personally test against navidrome. Agents did a few passes on gonic and LMS but they might be less stable.
- I primarily test Mac and occasionally Windows, did not test Linux at all.

### Mac — opening it the first time

muswag is signed with its own certificate rather than one from Apple, so macOS blocks it the first time.
Open System Settings › Privacy & Security and click Open Anyway, or run

```
xattr -dr com.apple.quarantine /Applications/muswag.app
```

Do not sign the app again yourself: macOS installs updates only on the app as it was released.
