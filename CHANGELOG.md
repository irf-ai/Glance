# Glance patch notes

## Unreleased — macOS

### New
- **Glance runs on macOS.** Two Mac builds:
  - macOS 13 Ventura and later, for Apple Silicon and Intel Macs (Electron 44).
  - A legacy build for Intel Macs on macOS 10.13 High Sierra to 12 Monterey
    (Electron 26). Electron 26 no longer gets security fixes, so use it only
    on Macs that can't update to macOS 13.
- On a Mac, Glance behaves like a Mac app: a Glance menu with About, Hide and
  Quit, a Window menu, files opened from Finder or the Dock, the app staying
  open with no windows, ⇧⌘Z for Redo, the unsaved-changes dot in the close
  button, and the file icon in the title bar.
- Shortcut hints and the Keyboard Shortcuts list show Mac keys (⌘ ⌥ ⇧) on a
  Mac. Dialogs mention Finder and the macOS print dialog. Pinch or ⌘+scroll
  zooms.
- Typed signatures use handwriting fonts that come with macOS (Snell
  Roundhand, Bradley Hand, Apple Chancery, Noteworthy, Brush Script).

Nothing changes on Windows.

## 1.3.1 — Printing and reliability fixes

### Fixed
- **Print (Ctrl+P) now always shows a dialog.** Glance has its own print
  dialog that opens straight away. Choose the printer, all, current or
  selected pages, copies, colour or black and white, and orientation, with a
  preview of the first page. Previously the Windows dialog could open behind
  the Glance window, or take a long time to appear on big documents. The
  Windows dialog is still available from a link in Glance's dialog.
- **Installing on unsupported PCs.** The installer now checks the PC first.
  On 32-bit Windows, Windows 7/8.1 or Windows 10 on ARM, it explains that
  Glance can't run there instead of installing an app that won't start.
- **Graphics driver crashes.** If the graphics process crashes, Glance
  switches to safe (software) graphics and restarts with your document.
- **Window crashes.** Glance offers to reopen the document.
- Error messages in dialogs disappear as soon as you correct the input.

### New
- Help › Open Log Folder, Help › Restart with Safe/Normal Graphics and
  Help › About Glance (version and system details).
- A log file for troubleshooting at `%APPDATA%Glancelogsglance.log`.

## 1.3.0 — Finishing touches

### New
- **Export to Word.** Export › Word document (.docx) gives editable text with
  headings, paragraphs and bullet lists, with each PDF page starting a new
  Word page. Pages without text, such as scans, are added as pictures. Images
  can be exported to Word too.
- **Saved signatures.** Signatures are saved with a name (for example "Full
  signature" or "Initials") under a new My signatures tab. Pick one to place
  it, or double-click it. Rename or delete them at any time. Your previous
  last-used signature is kept as "My signature".
- **Drag and drop between windows.** Drag a page thumbnail, an image, or the
  document name in the toolbar from one Glance window into another, and it's
  added with that window's markup. Drop PDFs and images from Explorer onto the
  page list to insert them where you drop.
- **Drag and drop into Combine.** The Combine list accepts files from
  Explorer and pages, images or documents dragged from other Glance windows.
  A new Add open documents button adds every document open in other windows.
- **Paste pictures** (Ctrl+V). Paste a copied PNG, JPEG or other image onto
  the current page, then move and resize it.
- **Copy page as a picture** (Ctrl+Shift+C). Copies the current page, or the
  image, with markup, ready to paste into Word, email or chat.
- **Keyboard shortcuts sheet** (F1 or ?). A searchable list of every
  shortcut.

### Fixed
- Clipboard access now works with the newer Electron clipboard API.

## 1.2.0 — Review, view and security

### New
- **Sticky notes.** Pin a note anywhere on a page or image. Notes show your
  name and the time, and exported PDFs keep them as standard PDF notes that
  Acrobat and other apps can read and edit.
- **Comments panel.** A new Comments tab in the sidebar lists every note and
  piece of markup by page. Click one to jump to it.
- **Fill & Sign marks.** One-click check mark, cross, dot and today's date for
  filling in paper-style forms. Marks can be resized from their corner handle.
- **Compare with another PDF.** Lists every word-level difference between two
  PDFs. Can add them to the document as highlights and notes.
- **Document properties** (Ctrl+D). File, page and PDF details, plus editable
  title, author, subject and keywords.
- **Attachments.** A paperclip tab in the sidebar to view, save, add and
  remove files embedded in a PDF.
- **Password-protected PDFs.** Open them by entering the password, and save
  copies protected with an open password and restrictions on printing,
  copying and editing (AES-256).
- **Print** (Ctrl+P). Prints with your markup and filled-in form fields
  through the Windows print dialog.
- **View modes.** Two-page spreads (Ctrl+2), dark pages for night reading
  (Ctrl+Shift+D), a page-number box in the status bar (Ctrl+G) and
  full-screen presentation mode (F5).

### Changed
- Glance now honours restrictions set by a PDF's owner. If a file doesn't
  allow editing, copying or printing, those actions are blocked and the
  status bar says why.
- The sidebar now has Pages, Comments and Attachments tabs.
- Running Glance from source no longer interferes with an installed copy.

### Fixed
- Focusing the page number box no longer scrolls the whole window.
- In two-page view, the current page now shows correctly near the end of the
  document.
- Leaving presentation mode on an image no longer causes an error.

### Known limits
- Restrictions on a protected PDF apply even if you know its permissions
  password.
- Compare checks text only, not images or layout.
- Printing uses page images at 150 dpi.

## 1.1.0 — PDF tools

### New
- **Tools menu** in the toolbar.
- **Combine files into PDF** (Ctrl+Shift+M). Merge PDFs and images in any
  order, with page size, orientation and margins for image pages.
- **Split PDF.** One file per page range, a new file every N pages, or
  extract chosen pages into one file.
- **Compress PDF.** Light, Strong and Extreme levels. Glance never saves a
  result that is larger than the original.
- **Crop PDF pages.** Crop the current page or all pages.
- **Signatures.** Draw, type or import a signature and place it on a page.
  The last one is remembered.
- **Add image.** Place any picture on a page and resize it.
- **Fill PDF forms.** Type into fillable fields. Exports keep the values, and
  the fields stay fillable.
- **Export all pages** as JPEG or PNG files, or export the text as Markdown
  or plain text.

### Fixed
- Exporting, thumbnails and compression no longer get stuck after typing
  into a form field.

## 1.0.0 — First release

- View PDFs and images with thumbnails, zoom, search and selectable text.
- Markup: highlight, rectangle, oval, line, arrow, freehand sketch and text,
  with undo and redo.
- Rotate, flip, crop and resize images. Rotate, reorder, delete and insert PDF
  pages.
- Export to PDF (with markup), PNG, JPEG and WebP.
- Never overwrites the file you opened.
