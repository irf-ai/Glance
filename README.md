# Glance

A Windows and macOS viewer for PDFs and images, modelled on the everyday features of
macOS Preview. It's an independent app written from scratch. It contains no
Apple code, artwork or branding.

## Features

**Viewing**
- PDFs: continuous scrolling, page thumbnails, selectable text, search
  (Ctrl+F, Enter / Shift+Enter to step through matches).
- Images: PNG, JPEG, GIF, BMP, WebP, AVIF, ICO. The sidebar lists the other
  images in the same folder. Use ← / → to move between them.
- Zoom with Ctrl+= / Ctrl+-, Ctrl+mouse wheel, Ctrl+0 (actual size) and
  Ctrl+9 (fit).
- Open files from File › Open, by dropping them on the window, or with
  "Open with" once installed.

**Markup** (pencil button or Ctrl+Shift+A)
- Highlight: select PDF text and press Highlight, or drag a box.
- Rectangle, oval, line, arrow, freehand sketch and text box. Hold Shift
  for squares, circles and 45° lines.
- Click markup to select it. Drag or use the arrow keys to move it, Delete to
  remove it, double-click text to edit it, and use the colour pickers to
  recolour it.
- Undo / redo with Ctrl+Z / Ctrl+Y.

**Editing**
- Images: rotate, flip, crop (crop tool, then Enter or Ctrl+K) and resize.
- PDFs: rotate, delete and drag to reorder pages in the sidebar. Insert pages
  from another PDF.

**PDF tools** (Tools button, new in 1.1)
- Combine files into PDF (Ctrl+Shift+M): merge PDFs and images in any
  order. Image pages can match the image size or use A4 or Letter, with
  automatic orientation and margins.
- Split PDF: one file per page range (`1-3, 5, 8-`), a new file every N
  pages, or extract chosen pages into one file.
- Compress PDF: Light tidies the file structure. Strong (150 dpi) and Extreme
  (96 dpi) turn each page into a JPEG, which gives much smaller files but
  makes text no longer selectable. Glance won't save a result that is larger
  than the original.
- Crop pages: drag the crop tool on a page, then choose Crop page or Crop all
  pages.
- Add signature: draw, type in a handwriting font, or import an image (white
  backgrounds can be made transparent). The last signature is remembered.
- Add image: place any picture on a page. Drag the corner handle to resize.
- Fill PDF forms: type into a PDF's fillable fields. Export keeps the values
  and the fields stay fillable.
- Export all pages as JPEG/PNG files, or export the text as Markdown or plain
  text.

**Review, view and security** (new in 1.2)
- Sticky notes: pin a note anywhere. The Comments tab in the sidebar lists
  every note and piece of markup; click one to jump to it. Exported PDFs keep
  notes as real PDF notes that Acrobat and other apps can read.
- Fill & Sign marks: one-click check, cross and dot marks plus today's date.
- Compare with another PDF: lists every word-level difference, and can add
  them to the document as highlights and notes.
- Document properties (Ctrl+D): file and page details, and editable title,
  author, subject and keywords.
- Attachments: view, save, add and remove files embedded in a PDF (paperclip
  tab in the sidebar).
- Passwords: open password-protected PDFs, and save copies protected with a
  password and printing/copying/editing restrictions (AES-256). Glance honours
  the restrictions of the PDFs it opens.
- Print (Ctrl+P) with markup and form entries, through Glance's own or the system print
  dialog.
- View modes: two-page spreads (Ctrl+2), dark pages (Ctrl+Shift+D), a page
  number box in the status bar (Ctrl+G), and full-screen presentation (F5).

**Finishing touches** (new in 1.3)
- Export to Word (.docx): editable headings, paragraphs and bullet lists;
  pages without text become pictures.
- Saved signatures with names, under My signatures in Add signature.
- Drag pages, images or the document name between Glance windows, drop files
  from Explorer or Finder onto the page list, and drop either into the Combine list.
- Paste a picture onto the page (Ctrl+V), copy the page as a picture
  (Ctrl+Shift+C), and see every shortcut with F1 or ?.

**Export** (Ctrl+Shift+S)
- PDFs are saved with markup as vector shapes and text, keeping the page
  order and rotation. A single page can also be exported as PNG or JPEG.
- Images can be exported as PNG, JPEG, WebP or a single-page PDF, with the
  markup merged in.

Glance never overwrites the file you opened. Export always asks where to save.

## System requirements

**Windows**
- 64-bit Windows 10 or Windows 11 (Intel/AMD). Windows 11 on ARM also works.
- Nothing else to install. Glance includes everything it needs, so it doesn't
  need Java, a separate JavaScript runtime or the Visual C++ redistributable.
- About 400 MB of disk space.

The installer stops with an explanation on 32-bit Windows, Windows 7/8.1 and
Windows 10 on ARM, where Glance can't run.

**macOS**

| Your Mac | Download |
|---|---|
| macOS 13 Ventura or later, Apple Silicon (M1 and later) | `Glance-<version>-mac-arm64.dmg` |
| macOS 13 Ventura or later, Intel | `Glance-<version>-mac-x64.dmg` |
| macOS 10.13 High Sierra to 12 Monterey (Intel) | `Glance-<version>-mac-legacy-x64.dmg` |

The legacy build uses an older Electron (26) that no longer gets security
fixes. Use it only on a Mac that can't update to macOS 13, and be careful
with PDFs from people you don't know.

Open the .dmg and drag Glance to Applications. Glance isn't notarized by
Apple, so the first time you open it macOS says it can't check it. On
macOS 10.13 to 14, Control-click Glance in Applications and choose Open. On
macOS 15 and later, open System Settings › Privacy & Security and choose
Open Anyway.

## If Glance crashes

- Glance keeps a log at `%APPDATA%\Glance\logs\glance.log` on Windows and
  `~/Library/Logs/Glance/glance.log` on a Mac (Help › Open Log Folder).
- If the graphics driver crashes, Glance switches to safe graphics and
  restarts by itself. You can also choose Help › Restart with Safe Graphics,
  or start it with `Glance.exe --safe-mode`.
- If a window crashes, Glance offers to reopen the document.
- Windows SmartScreen may warn that the installer is from an unknown
  publisher, because it isn't code-signed. Choose More info › Run anyway.

## Run from source

```
npm install
npm start
```

`npm run start:legacy` runs it on Electron 26 instead, the version the legacy
Mac build uses, so you can check that older Macs will work.

## Build the installer

```
npm run dist
```

The installer is written to `dist/Glance Setup <version>.exe`.

The Mac builds have to be made on a Mac:

```
npm run dist:mac
npm run dist:mac-legacy
```

Without a Mac, use the **Build macOS** workflow on GitHub (Actions › Build
macOS › Run workflow). The .dmg files appear under the run's Artifacts.

## Known limits

- Combining, splitting or reordering pages copies them into a new file, so
  bookmarks and fillable fields from the originals aren't carried over.
  Exporting a PDF whose page layout is unchanged keeps both.
- Markdown export guesses headings from font size. Scanned PDFs have no text
  to export because there is no OCR.
- Web links in PDFs aren't clickable. Links to other pages in the same PDF work.
- Markup other than sticky notes is flattened on export and can't be edited
  again after reopening.
- Restrictions on a protected PDF apply even if you know its permissions
  password. Remove them in the app that set them.
- Compare checks text only, not images or layout.
- Printing prints page images at 150 dpi.
- Text markup in exported PDFs uses Helvetica. Characters outside Western
  European scripts show as `?` in the PDF but stay correct in image exports.
- GIF and BMP can be opened but not saved. Export as PNG instead.
