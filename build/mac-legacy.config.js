// Build for older Macs (macOS 10.13 High Sierra to 12 Monterey), which
// Electron 44 no longer supports. Same app, packaged with Electron 26 and
// pdf.js's legacy build. Run with: npm run dist:mac-legacy
//
// Electron 26 no longer gets security fixes, so this build is only for Macs
// that can't update to macOS 13. Everyone else should use the main build.

const { build } = require("../package.json");

module.exports = {
  ...build,
  electronVersion: "26.6.10",
  files: [
    // main.js serves these instead of the modern pdf.js build on Electron 26.
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ...build.files.filter((pattern) => pattern !== "!node_modules/pdfjs-dist/legacy/**"),
    "!node_modules/pdfjs-dist/legacy/{web,image_decoders}/**",
    "!node_modules/pdfjs-dist/legacy/build/*.{min.mjs,sandbox.mjs}",
  ],
  mac: {
    ...build.mac,
    // Macs that run 10.13–12 but not 13 are all Intel. Apple Silicon Macs can
    // all run macOS 13 and should use the main build.
    target: [{ target: "dmg", arch: ["x64"] }],
    minimumSystemVersion: "10.13",
    artifactName: "${productName}-${version}-mac-legacy-${arch}.${ext}",
  },
};
