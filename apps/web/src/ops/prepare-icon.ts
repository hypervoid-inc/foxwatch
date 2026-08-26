const MAX_ICON_BYTES = 256 * 1024;
const EDGES = [512, 384, 256, 192, 128, 96];

export function fitIconSize(width: number, height: number, max = 512): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(avif|bmp|gif|heic|heif|ico|jfif|jpe?g|jxl|png|svg|tiff?|webp)$/i.test(file.name);
}

export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function fileFromDrop(dt: DataTransfer | null): File | null {
  if (!dt?.files.length) return null;
  const files = [...dt.files];
  return files.find(isImageFile) ?? files[0] ?? null;
}

function sniffAllowed(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
}

async function bitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(blob);
  }
}

function bitmapFromElement(blob: Blob): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      createImageBitmap(img)
        .then(resolve, reject)
        .finally(() => URL.revokeObjectURL(url));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

async function bitmapFromHeic(blob: Blob): Promise<ImageBitmap> {
  const file = blob instanceof File ? blob : new File([blob], "image.heic");
  const { heicTo, isHeic } = await import("heic-to/csp");
  if (!(await isHeic(file))) throw new Error("decode");
  try {
    return await heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
  } catch {
    return heicTo({ blob: file, type: "bitmap" });
  }
}

async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await bitmapFromBlob(file);
  } catch {
    /* try element decode (SVG, some AVIF) */
  }
  try {
    return await bitmapFromElement(file);
  } catch {
    /* HEIC/HEIF in Chromium */
  }
  return bitmapFromHeic(file);
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("encode"))),
      type,
      quality,
    );
  });
}

async function rasterize(bitmap: ImageBitmap): Promise<File> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encode");
  const attempts: Array<[string, number | undefined]> = [
    ["image/png", undefined],
    ["image/webp", 0.92],
    ["image/webp", 0.78],
    ["image/jpeg", 0.88],
    ["image/jpeg", 0.7],
  ];
  for (const edge of EDGES) {
    const { width, height } = fitIconSize(bitmap.width, bitmap.height, edge);
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const [type, quality] of attempts) {
      try {
        const blob = await canvasBlob(canvas, type, quality);
        if (blob.size > MAX_ICON_BYTES) continue;
        const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
        return new File([blob], `icon.${ext}`, { type: blob.type || type });
      } catch {
        /* encoder missing for this type */
      }
    }
  }
  throw new Error("too_large");
}

export async function prepareSiteIcon(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeImage(file);
  } catch {
    if (file.size <= MAX_ICON_BYTES && sniffAllowed(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) {
      return file;
    }
    throw new Error("decode");
  }
  try {
    return await rasterize(bitmap);
  } finally {
    bitmap.close();
  }
}
