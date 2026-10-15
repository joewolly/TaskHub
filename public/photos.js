// Normalize large browser-decodable photos without changing the server's limit.
export async function preparePhoto(file) {
  if (file.size <= 1024 * 1024 && !/hei[cf]/i.test(file.type + file.name)) return file;
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error(`${file.name}: this photo format cannot be read. Choose a JPEG or PNG, or use your camera's compatible format.`); }
  try {
    let edge = 1800;
    while (edge >= 450) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
      if (blob && blob.size <= 1024 * 1024) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
      edge = Math.floor(edge * .7);
    }
    throw new Error(`${file.name}: this photo is still too large. Choose a smaller image.`);
  } finally { bitmap.close(); }
}
