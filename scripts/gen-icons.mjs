// Generates the Moneyero app icon source (1024x1024 PNG) with zero dependencies,
// then `npx tauri icon` turns it into every platform format under src-tauri/icons.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const S = 1024;
const BG = [7, 7, 7, 255];
const OR = [255, 102, 0, 255];
const px = new Uint8Array(S * S * 4);

function set(x, y, c) {
  const i = (y * S + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
}
function rect(x0, y0, x1, y1, c) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
}

rect(0, 0, S, S, BG);
// outer frame
rect(48, 48, S - 48, S - 48, OR);
rect(80, 80, S - 80, S - 80, BG);
// bracket glyph: [ ■ ]
rect(200, 260, 260, 764, OR);
rect(200, 260, 360, 300, OR);
rect(200, 724, 360, 764, OR);
rect(S - 260, 260, S - 200, 764, OR);
rect(S - 360, 260, S - 200, 300, OR);
rect(S - 360, 724, S - 200, 764, OR);
// the box
rect(432, 432, 592, 592, OR);
// cursor underscore
rect(620, 560, 700, 592, OR);

// --- PNG encode
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("scripts/out", { recursive: true });
writeFileSync("scripts/out/icon-src.png", png);
console.log("wrote scripts/out/icon-src.png");
execSync("npx tauri icon scripts/out/icon-src.png -o src-tauri/icons", { stdio: "inherit" });
