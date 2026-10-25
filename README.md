# muswag

navidrome\opensubsonic client in development

### Mac — opening it the first time

muswag is signed with its own certificate rather than one from Apple, so macOS blocks it the first time.
Open System Settings › Privacy & Security and click Open Anyway, or run

```
xattr -dr com.apple.quarantine /Applications/muswag.app
```

Do not sign the app again yourself: macOS installs updates only on the app as it was released.
