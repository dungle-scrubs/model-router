/**
 * Images for the Jev client.
 *
 * A `JevImage` is a PNG or JPEG file checked against the System One image
 * limits when it is made, so a broken limit is a coded `JevError` before any
 * request. The caller places the image object in the state or in a
 * question's instructions; `askJev` turns each placement into a reference
 * and sends the file bytes beside the JSON. The caller never builds the wire
 * format.
 *
 * The limits are the ones https://docs.typesafe.ai/images states. Image
 * input is experimental there, so the figures can change between releases.
 */

import { type FileHandle, open } from "node:fs/promises";
import { JevError } from "./jev-error.js";

/** The largest image file the API accepts, in bytes. Both ends inclusive. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** The shortest side the API accepts, in pixels. */
export const MIN_IMAGE_SIDE = 280;
/** The longest side the API accepts, in pixels. */
export const MAX_IMAGE_SIDE = 1568;

export type JevImageFormat = "png" | "jpeg";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Each image's bytes, held outside the object so the public type carries
 * no field for them. */
const IMAGE_BYTES = new WeakMap<JevImage, Uint8Array>();

type Header = { readonly format: JevImageFormat; readonly height: number; readonly width: number };

function formatError(source: string, reason: string): JevError {
  return new JevError(
    "IMAGE_FORMAT",
    `the image ${source} is not usable: ${reason}. The API accepts still PNG and JPEG images only.`,
  );
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Walk a PNG's chunks to IEND: read the size from IHDR, require image
 * data before IEND and every chunk to fit in the file, and refuse an
 * animated PNG, which an `acTL` chunk marks. Only the chunk framing is
 * checked, not the compressed pixels: a file damaged inside its image data
 * still reaches the API, which rejects it. */
function readPng(bytes: Uint8Array, view: DataView, source: string): Header {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || chunkType(bytes, 12) !== "IHDR") {
    throw formatError(source, "the PNG header is damaged or incomplete");
  }
  const height = view.getUint32(20);
  const width = view.getUint32(16);
  let hasImageData = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) break;
    const type = chunkType(bytes, offset + 4);
    if (type === "acTL") throw formatError(source, "it is an animated PNG");
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (!hasImageData) throw formatError(source, "the PNG has no image data");
      return { format: "png", height, width };
    }
    offset += 12 + length;
  }
  throw formatError(source, "the PNG is cut off before its end chunk");
}

/** Start-of-frame markers carry the size: every SOFn except DHT (C4), JPG
 * (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** True when an end-of-image marker (FF D9) sits at or after `from`. */
function hasEndMarker(bytes: Uint8Array, from: number): boolean {
  for (let index = bytes.length - 2; index >= from; index--) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) return true;
  }
  return false;
}

/** Walk a JPEG's marker segments: read the size from the frame header,
 * require every segment to fit in the file, a scan after the frame header,
 * and an end-of-image marker after the scan. Only the segment framing is
 * checked, not the compressed pixels. */
function readJpeg(bytes: Uint8Array, view: DataView, source: string): Header {
  let frame: Header | undefined;
  let offset = 2;
  while (offset < bytes.length && bytes[offset] === 0xff) {
    // Fill bytes: any number of 0xFF may precede a marker.
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset];
    offset++;
    if (marker === undefined) break;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) {
      throw formatError(source, "a JPEG segment is damaged or cut off");
    }
    if (isStartOfFrame(marker)) {
      // Precision, height, width and component count follow the length.
      if (length < 8) throw formatError(source, "the JPEG frame header is damaged");
      frame = {
        format: "jpeg",
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    if (marker === 0xda) {
      if (frame === undefined) break;
      if (!hasEndMarker(bytes, offset + length)) {
        throw formatError(source, "the JPEG is cut off before its end marker");
      }
      return frame;
    }
    offset += length;
  }
  throw formatError(
    source,
    frame === undefined ? "the JPEG has no readable frame header" : "the JPEG has no image data",
  );
}

function readHeader(bytes: Uint8Array, source: string): Header {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return readPng(bytes, view, source);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return readJpeg(bytes, view, source);
  }
  throw formatError(source, "its bytes are neither PNG nor JPEG");
}

function fileSizeError(source: string, size: number): JevError {
  return new JevError(
    "IMAGE_FILE_SIZE",
    `the image ${source} is ${size} bytes, above the ${MAX_IMAGE_BYTES}-byte (16 MiB) limit per image file. Send a smaller or more compressed copy.`,
  );
}

/** A PNG or JPEG image checked against the System One limits, ready to place
 * in a Jev state or a question's instructions. Make one with
 * `JevImage.fromFile` or `JevImage.fromBytes`. The bytes are copied when the
 * image is made, so a later write to the caller's buffer changes nothing
 * that is sent. */
export class JevImage {
  /** The format read from the bytes, never from a file name. */
  readonly format: JevImageFormat;
  /** Width and height in pixels as stored. The API applies no EXIF
   * orientation: a photo must be rotated upright in its pixels. */
  readonly width: number;
  readonly height: number;

  private constructor(bytes: Uint8Array, header: Header) {
    IMAGE_BYTES.set(this, bytes);
    this.format = header.format;
    this.width = header.width;
    this.height = header.height;
  }

  /** The size of the image file in bytes. */
  get byteLength(): number {
    return imageBytes(this).byteLength;
  }

  /** Check image file bytes and copy them. Throws `JevError` with
   * `IMAGE_FORMAT` (not a still PNG or JPEG, or damaged), `IMAGE_FILE_SIZE`
   * (over 16 MiB) or `IMAGE_DIMENSIONS` (a side outside 280 to 1568
   * pixels). */
  static fromBytes(data: Uint8Array | ArrayBuffer): JevImage {
    const source = "given as bytes";
    // Refused before the copy, so an oversized buffer is never duplicated.
    if (data.byteLength > MAX_IMAGE_BYTES) throw fileSizeError(source, data.byteLength);
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    return JevImage.#check(Uint8Array.prototype.slice.call(view), source);
  }

  /** Read an image file and check it as `fromBytes` does. A path that
   * cannot be read, or is not a regular file, is `IMAGE_UNREADABLE`; a file
   * over 16 MiB is refused before it is read. The size check and the read
   * use one open handle, so they see the same file. */
  static async fromFile(path: string): Promise<JevImage> {
    const source = `at ${path}`;
    let bytes: Uint8Array;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new JevError("IMAGE_UNREADABLE", `the image ${source} is not a regular file`);
      }
      if (stats.size > MAX_IMAGE_BYTES) throw fileSizeError(source, stats.size);
      bytes = await handle.readFile();
    } catch (error) {
      if (error instanceof JevError) throw error;
      throw new JevError(
        "IMAGE_UNREADABLE",
        `the image ${source} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await handle?.close();
    }
    return JevImage.#check(bytes, source);
  }

  /** An image turned into text would reach Jev as "[object Object]" in a
   * plain JSON request, with no image attached. Refuse it instead. */
  [Symbol.toPrimitive](): never {
    throw new TypeError(
      "a JevImage cannot be turned into text; place the JevImage object itself in the state or the instructions",
    );
  }

  toString(): never {
    return this[Symbol.toPrimitive]();
  }

  static #check(bytes: Uint8Array, source: string): JevImage {
    if (bytes.byteLength === 0) throw formatError(source, "it is empty");
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw fileSizeError(source, bytes.byteLength);
    const header = readHeader(bytes, source);
    for (const [side, value] of [
      ["width", header.width],
      ["height", header.height],
    ] as const) {
      if (value < MIN_IMAGE_SIDE || value > MAX_IMAGE_SIDE) {
        throw new JevError(
          "IMAGE_DIMENSIONS",
          `the image ${source} has a ${side} of ${value} pixels, outside the ${MIN_IMAGE_SIDE} to ${MAX_IMAGE_SIDE} pixel range the API accepts for each side. Scale it into the range before sending; the API never resizes.`,
        );
      }
    }
    return new JevImage(bytes, header);
  }
}

/** The file bytes of an image, for the client that sends them. Not
 * exported from the package. */
export function imageBytes(image: JevImage): Uint8Array {
  const bytes = IMAGE_BYTES.get(image);
  if (bytes === undefined)
    throw new TypeError("not an image made by JevImage.fromBytes or fromFile");
  return bytes;
}
