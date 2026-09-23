# Bunkr Media Batch Downloader

Tampermonkey userscript that adds separate **Download All Videos** and **Download All Images** controls to Bunkr album pages.

## Install

Install Tampermonkey, then open the raw userscript:

https://raw.githubusercontent.com/bomboclaat12369/bunkr-media-batch-downloader/main/bunkr_media_batch_downloader.user.js

Tampermonkey will detect the userscript and offer to install it.

## Automatic updates

The userscript contains `@updateURL` and `@downloadURL` metadata pointing back to this repository. Future version bumps pushed to `main` can therefore be picked up by Tampermonkey without manually downloading a replacement ZIP each time.

## Current behavior

- Separate video and image batch buttons.
- Album media-type detection.
- Original filenames where available.
- Progress and failure reporting.
- Stop control.
- Folder-selection build intended to choose a destination once per batch.

Use this only for media you are authorized to download.
