# muswag

navidrome\opensubsonic client in development

### Mac — “muswag.app” is damaged and can’t be opened.

Apple is strict on running unsigned apps and signing them requires paid developer account.
Run these in terminal to self-sign and then launch

```
sudo xattr -d com.apple.quarantine /Applications/muswag.app

sudo codesign --force --deep --sign - /Applications/muswag.app
```
