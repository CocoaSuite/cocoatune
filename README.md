# CocoaTune

A compact music player from the CocoaSuite. It plays your own audio files, saves audio from web links, and keeps everything in one local library with simple playlists.

## Features

- **Local files:** add with **+ Files** or drag them onto the window. Files are copied into the library, so the originals can move.
- **Links:** paste a link and press **Save**. Direct audio links (.mp3, .ogg and so on) download as they are. Page links such as YouTube or SoundCloud go through [yt-dlp](https://github.com/yt-dlp/yt-dlp), which CocoaTune downloads on first use and keeps updated.
- **Playlists:** press **+** in the tab row to create one, then use **⋯** (or right-click) on a track to add it. Right-click a playlist tab to delete it.
- **Display on top:** the pin button keeps the window above other windows.
- **Mini bar:** the minimize button shrinks CocoaTune to a small bar in the bottom-right corner that always stays on top. Double-click it or press the square button to expand.
- Shuffle, repeat (all / one), seeking, media keys, and **Space** / **← →** shortcuts.

## Run

```bash
npm install
npm start
```

Build an installer for your platform:

```bash
npm run dist
```

## Where things are stored

The library (audio files and `library.json`) lives in the app's user data folder. Open it from **☰ → Open library folder**.

## Note on saving from links

Only save audio you have the right to keep, such as your own uploads or Creative Commons tracks. Many sites, including YouTube, restrict downloading in their terms of service.
