import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, describe, expect, test, vi } from "vitest";
import { askJev, JevError, JevImage, type JevQuestion } from "../src/jev.js";
import { fixturesDir, withEnv } from "./helpers.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MiB = 1024 * 1024;

/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + data.length);
  return out;
}

/** A made-up, valid grey PNG of the given size. `animated` adds an acTL
 * chunk before the image data, which marks an APNG. */
function makePng(width: number, height: number, animated = false): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0; // filter: none
  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(1, 0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(animated ? [chunk("acTL", acTL)] : []),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** The segment framing of a made-up baseline JPEG: SOI, an APP0 segment,
 * a fill byte, a SOF0 frame header with the given size, a scan header,
 * placeholder scan bytes and EOI. The client checks only the framing, so the
 * scan bytes need not decode; tests/fixtures/jev-image-300.jpg is a real
 * one. */
function makeJpeg(width: number, height: number, frameMarker = 0xc0): Uint8Array {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(frameMarker, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    Buffer.from([0xff]),
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x0c, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A valid image padded with trailing bytes to exactly `size` bytes. */
function padded(image: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(image);
  return out;
}

const NOUL: Record<string, JevQuestion> = {
  amount: { type: "noul", instructions: "Does the slip in `slip` show the amount 1,250.50?" },
};

const ok = (answers: unknown): Response =>
  new Response(
    JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 9, output_tokens: 1 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

type Sent = {
  readonly body: string | Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
};

/** A fetch that records each request and answers the one noul question. */
function recorder(response: () => Response = () => ok({ amount: { type: "noul", noul: 0.9 } })): {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push({
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as string | Uint8Array,
    });
    return response();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

/** Parse a multipart body the way a server would. */
async function parts(sent: Sent): Promise<FormData> {
  const contentType = sent.headers["Content-Type"];
  expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
  return new Response(sent.body as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": contentType as string },
  }).formData();
}

/** The JSON part. It carries no filename, as the official SDK sends it, so
 * a server reads it as a text field. */
function requestJson(form: FormData): Record<string, unknown> {
  const request = form.get("request");
  expect(typeof request).toBe("string");
  return JSON.parse(request as string) as Record<string, unknown>;
}

function thrown(run: () => unknown): JevError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JevError);
    return error as JevError;
  }
  throw new Error("expected a JevError");
}

async function rejected(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JevError);
    return error as JevError;
  }
  throw new Error("expected a rejection");
}

const withKey = (fn: () => Promise<void>): Promise<void> =>
  withEnv({ TYPESAFE_API_KEY: "test-key" }, fn);

describe("a request with no image", () => {
  test("is byte-for-byte the JSON request the client sent before images", () =>
    withKey(async () => {
      const { fetch, sent } = recorder();
      await askJev({ text: "slip 1", lines: [1, 2.5, null], at: new Date(0) }, NOUL, { fetch });
      expect(sent).toHaveLength(1);
      // The literal body and headers of the 0.2.1 client for this call.
      expect(sent[0]?.body).toBe(
        '{"state":{"text":"slip 1","lines":[1,2.5,null],"at":"1970-01-01T00:00:00.000Z"},"model":"jev-1.13.0","questions":{"amount":{"type":"noul","instructions":"Does the slip in `slip` show the amount 1,250.50?"}}}',
      );
      expect(sent[0]?.headers).toEqual({
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      });
    }));
});

describe("a request with images", () => {
  test("sends a JPEG in the state as a file part named in assets, with the images header", () =>
    withKey(async () => {
      const bytes = makeJpeg(1200, 900);
      const slip = JevImage.fromBytes(bytes);
      const { fetch, sent } = recorder();
      const response = await askJev({ slip, note: "photo of a payment slip" }, NOUL, { fetch });
      expect(response.answers.amount).toEqual({ type: "noul", noul: 0.9 });

      const headers = sent[0]?.headers ?? {};
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
      expect(Object.keys(headers).sort()).toEqual([
        "Authorization",
        "Content-Type",
        "TypeSafe-Danger-Zone-Images",
      ]);

      const form = await parts(sent[0] as Sent);
      const json = requestJson(form);
      expect(Object.keys(json)).toEqual(["state", "model", "questions", "assets"]);
      const state = json.state as { slip: string; note: string };
      expect(state.note).toBe("photo of a payment slip");
      expect(state.slip).toMatch(/^jev-image-[0-9a-f-]{36}$/);
      expect(json.model).toBe("jev-1.13.0");
      expect(json.questions).toEqual(NOUL);
      expect(json.assets).toEqual({ [state.slip]: { type: "image", part: "image-1" } });

      const file = form.get("image-1");
      expect(file).toBeInstanceOf(File);
      expect((file as File).type).toBe("image/jpeg");
      expect((file as File).name).toBe("image-1.jpg");
      expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(new Uint8Array(bytes));
      expect([...form.keys()]).toEqual(["request", "image-1"]);
      // The JSON part comes first and states its own content type.
      expect(Buffer.from(sent[0]?.body as Uint8Array).toString("latin1")).toMatch(
        /^--model-router-[0-9a-f-]{36}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application\/json\r\n\r\n\{"state":/,
      );
    }));

  test("an image placed twice is one asset and one part under one reference", () =>
    withKey(async () => {
      const slip = JevImage.fromBytes(makePng(300, 300));
      const { fetch, sent } = recorder();
      await askJev(
        { front: slip },
        { amount: { type: "noul", instructions: ["Is this the same slip as `front`?", slip] } },
        { fetch },
      );
      const form = await parts(sent[0] as Sent);
      const json = requestJson(form);
      const reference = (json.state as { front: string }).front;
      expect(
        (json.questions as { amount: { instructions: unknown[] } }).amount.instructions[1],
      ).toBe(reference);
      expect(Object.keys(json.assets as object)).toEqual([reference]);
      expect([...form.keys()]).toEqual(["request", "image-1"]);
      expect((form.get("image-1") as File).type).toBe("image/png");
    }));

  test("two images are two parts, each with a fresh reference per request", () =>
    withKey(async () => {
      const front = JevImage.fromBytes(makePng(300, 400));
      const back = JevImage.fromBytes(makeJpeg(400, 300));
      const { fetch, sent } = recorder();
      await askJev([front, back], NOUL, { fetch });
      await askJev([front, back], NOUL, { fetch });
      const first = requestJson(await parts(sent[0] as Sent));
      const second = requestJson(await parts(sent[1] as Sent));
      const [a, b] = first.state as string[];
      expect(first.assets).toEqual({
        [a as string]: { type: "image", part: "image-1" },
        [b as string]: { type: "image", part: "image-2" },
      });
      expect(second.state).not.toEqual(first.state);
    }));

  test("a retried request resends the same body and headers", () =>
    withKey(async () => {
      const slip = JevImage.fromBytes(makeJpeg(600, 600));
      let calls = 0;
      const { fetch, sent } = recorder(() =>
        calls++ === 0
          ? new Response("busy", { status: 429 })
          : ok({ amount: { type: "noul", noul: 0.2 } }),
      );
      await askJev({ slip }, NOUL, { fetch, sleep: async () => {}, backoffMs: 0 });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.body).toEqual(sent[0]?.body);
      expect(sent[1]?.headers).toEqual(sent[0]?.headers);
    }));

  test("the bytes are copied when the image is made", () =>
    withKey(async () => {
      const bytes = makeJpeg(500, 500);
      const original = new Uint8Array(bytes);
      const slip = JevImage.fromBytes(bytes);
      bytes.fill(0);
      const { fetch, sent } = recorder();
      await askJev({ slip }, NOUL, { fetch });
      const file = (await parts(sent[0] as Sent)).get("image-1") as File;
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(original);
    }));

  test("more distinct images than the 65536-byte reference limit allows is REQUEST_TOO_LARGE", () =>
    withKey(async () => {
      // Each reference is 46 bytes: 1424 fit, 1425 do not.
      const many = (count: number): JevImage[] =>
        Array.from({ length: count }, () => JevImage.fromBytes(makePng(280, 280)));
      const { fetch } = recorder();
      await askJev({ images: many(1424) }, NOUL, { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      const error = await rejected(askJev({ images: many(1425) }, NOUL, { fetch }));
      expect(error.code).toBe("REQUEST_TOO_LARGE");
      expect(error.message).toContain("references total 65550 bytes");
      expect(fetch).toHaveBeenCalledTimes(1);
    }));

  test("a request body over 32 MiB is REQUEST_TOO_LARGE and nothing is sent", () =>
    withKey(async () => {
      const images = [1, 2, 3].map(() => JevImage.fromBytes(padded(makeJpeg(400, 400), 11 * MiB)));
      const { fetch } = recorder();
      const error = await rejected(askJev({ images }, NOUL, { fetch }));
      expect(error.code).toBe("REQUEST_TOO_LARGE");
      expect(error.message).toContain("33554432-byte (32 MiB)");
      expect(fetch).not.toHaveBeenCalled();
    }));
});

const PNG = Buffer.from(makePng(300, 300));
const JPEG = Buffer.from(makeJpeg(300, 300));

describe("JevImage checks", () => {
  test("accepts a real baseline JPEG", () => {
    const real = readFileSync(join(fixturesDir, "jev-image-300.jpg"));
    expect(JevImage.fromBytes(real)).toMatchObject({ format: "jpeg", height: 300, width: 300 });
  });

  test("an image turned into text throws instead of sending [object Object]", () => {
    const slip = JevImage.fromBytes(JPEG);
    expect(() => `photo ${slip}`).toThrow(TypeError);
    expect(() => String(slip)).toThrow(/place the JevImage object itself/);
  });

  test("reads the format and size from PNG and JPEG bytes", () => {
    expect(JevImage.fromBytes(makePng(281, 1567))).toMatchObject({
      format: "png",
      width: 281,
      height: 1567,
    });
    const jpeg = makeJpeg(1568, 280, 0xc2);
    expect(
      JevImage.fromBytes(
        jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer,
      ),
    ).toMatchObject({
      format: "jpeg",
      width: 1568,
      height: 280,
      byteLength: jpeg.byteLength,
    });
  });

  test.each([
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"), "neither PNG nor JPEG"],
    ["an empty file", new Uint8Array(), "it is empty"],
    ["an animated PNG", makePng(300, 300, true), "animated PNG"],
    ["a cut-off PNG", makePng(300, 300).subarray(0, 20), "PNG header is damaged"],
    [
      "a JPEG with no frame header",
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      "no readable frame header",
    ],
    [
      "a PNG with no image data",
      Buffer.concat([PNG.subarray(0, 33), PNG.subarray(-12)]),
      "no image data",
    ],
    ["a PNG cut off inside its image data", PNG.subarray(0, 51), "cut off before its end chunk"],
    [
      "a PNG cut off before its end chunk",
      PNG.subarray(0, PNG.length - 12),
      "cut off before its end chunk",
    ],
    [
      "a JPEG whose frame header is too short to hold a size",
      Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0xff, 0xd9,
      ]),
      "frame header is damaged",
    ],
    ["a JPEG cut off inside a segment", JPEG.subarray(0, 10), "segment is damaged or cut off"],
    [
      "a JPEG with no scan",
      Buffer.concat([
        JPEG.subarray(0, JPEG.indexOf(Buffer.from([0xff, 0xda]))),
        Buffer.from([0xff, 0xd9]),
      ]),
      "no scan data",
    ],
    [
      "a JPEG cut off before its end marker",
      JPEG.subarray(0, JPEG.length - 2),
      "cut off before its end marker",
    ],
    [
      "a PNG whose only image data chunk is empty",
      Buffer.concat([
        PNG.subarray(0, 33),
        Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0x35, 0xaf, 0x06, 0x1e]),
        PNG.subarray(-12),
      ]),
      "no image data",
    ],
    [
      "a JPEG whose scan header runs straight into its end marker",
      Buffer.concat([JPEG.subarray(0, JPEG.length - 7), Buffer.from([0xff, 0xd9])]),
      "no scan data",
    ],
    [
      "a JPEG whose end marker sits inside a segment cut off after the scan",
      Buffer.concat([
        JPEG.subarray(0, JPEG.length - 7),
        Buffer.from([0x12, 0x34, 0xff, 0xe1, 0xff, 0xff, 0xff, 0xd9]),
      ]),
      "segment is damaged or cut off",
    ],
    [
      "a JPEG with junk where a marker belongs",
      Buffer.concat([JPEG.subarray(0, 20), Buffer.from([0x00]), JPEG.subarray(20)]),
      "marker is damaged",
    ],
  ])("%s is IMAGE_FORMAT", (_name, bytes, reason) => {
    const error = thrown(() => JevImage.fromBytes(bytes));
    expect(error.code).toBe("IMAGE_FORMAT");
    expect(error.message).toContain(reason);
  });

  test.each([
    [279, 300, "width of 279"],
    [300, 279, "height of 279"],
    [1569, 300, "width of 1569"],
    [300, 1569, "height of 1569"],
  ])("a %ix%i image is IMAGE_DIMENSIONS", (width, height, named) => {
    for (const bytes of [makePng(width, height), makeJpeg(width, height)]) {
      const error = thrown(() => JevImage.fromBytes(bytes));
      expect(error.code).toBe("IMAGE_DIMENSIONS");
      expect(error.message).toContain(named);
      expect(error.message).toContain("280 to 1568");
    }
  });

  test("an image file of exactly 16 MiB is accepted and one byte more is IMAGE_FILE_SIZE", () => {
    expect(JevImage.fromBytes(padded(makePng(300, 300), 16 * MiB)).byteLength).toBe(16 * MiB);
    const error = thrown(() => JevImage.fromBytes(padded(makePng(300, 300), 16 * MiB + 1)));
    expect(error.code).toBe("IMAGE_FILE_SIZE");
    expect(error.message).toContain("16777217 bytes");
  });
});

describe("JevImage.fromFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-image-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads and checks a JPEG on disk", async () => {
    const path = join(dir, "slip.jpg");
    writeFileSync(path, makeJpeg(800, 600));
    expect(await JevImage.fromFile(path)).toMatchObject({
      format: "jpeg",
      width: 800,
      height: 600,
    });
  });

  test("a missing file is IMAGE_UNREADABLE naming the path", async () => {
    const path = join(dir, "missing.jpg");
    const error = await rejected(JevImage.fromFile(path));
    expect(error.code).toBe("IMAGE_UNREADABLE");
    expect(error.message).toContain(path);
  });

  test("a file over 16 MiB is IMAGE_FILE_SIZE", async () => {
    const path = join(dir, "huge.png");
    writeFileSync(path, makePng(300, 300));
    truncateSync(path, 16 * MiB + 1);
    const error = await rejected(JevImage.fromFile(path));
    expect(error.code).toBe("IMAGE_FILE_SIZE");
  });

  test.each([
    ["a directory", () => dir],
    ["a device", () => "/dev/null"],
    [
      "a FIFO with no writer",
      () => {
        const fifo = join(dir, "pipe.jpg");
        execFileSync("mkfifo", [fifo]);
        return fifo;
      },
    ],
  ])("%s is IMAGE_UNREADABLE as not a regular file", async (_name, path) => {
    const error = await rejected(JevImage.fromFile(path()));
    expect(error.code).toBe("IMAGE_UNREADABLE");
    expect(error.message).toContain("not a regular file");
  });

  test("a file in another format is IMAGE_FORMAT naming the path", async () => {
    const path = join(dir, "slip.webp");
    writeFileSync(path, Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"));
    const error = await rejected(JevImage.fromFile(path));
    expect(error.code).toBe("IMAGE_FORMAT");
    expect(error.message).toContain(path);
  });
});

test("the endpoint the image tests assume is the client's", async () =>
  withKey(async () => {
    const { fetch } = recorder();
    await askJev("state", NOUL, { fetch });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(ENDPOINT);
  }));
