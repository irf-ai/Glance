// Password support uses @cantoo/pdf-lib, a pdf-lib fork that can decrypt and
// encrypt (AES-256). It is only loaded when a protected PDF is involved.

let library;
const load = async () => (library ??= await import("app://glance/pdf-crypto/pdf-lib.esm.js"));

// Returns decrypted bytes, or null when the file isn't encrypted.
// Throws when the password is wrong or the encryption isn't supported.
export async function decryptPdf(bytes, password = "") {
  const { PDFDocument } = await load();
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (!probe.isEncrypted) return null;
  const doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
  return doc.save();
}

// permissions: { printing, copying, modifying, annotating, fillingForms } booleans.
export async function encryptPdf(bytes, { userPassword, ownerPassword, permissions }) {
  const { PDFDocument } = await load();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.encrypt({
    userPassword,
    ownerPassword,
    permissions: {
      printing: permissions.printing ? "highResolution" : false,
      copying: permissions.copying,
      modifying: permissions.modifying,
      annotating: permissions.annotating,
      fillingForms: permissions.fillingForms,
      contentAccessibility: true,
      documentAssembly: permissions.modifying,
    },
  });
  return doc.save();
}
