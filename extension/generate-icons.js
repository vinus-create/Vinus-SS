// node generate-icons.js — no external deps, uses zlib built-in
const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let c = 0xFFFFFFFF;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let j = 0; j < 8; j++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
    table[i] = v;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.concat([t, data]);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, t, data, crcVal]);
}

function makePNG(size) {
  // Orange (#f97316) background, white "S" — render as solid color block
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 3 + 1);
    row[0] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const px = 1 + x * 3;
      // Simple "S" shape: white pixels, else orange
      const nx = x / size, ny = y / size;
      // Rounded rect background = orange
      let r = 249, g = 115, b = 22; // #f97316
      // Draw white "S" using a simple bitmask approach
      const cx = (nx - 0.5) * 2, cy = (ny - 0.5) * 2; // -1 to 1
      // S shape: top arc, middle, bottom arc
      const inTopArc    = cy < -0.05 && Math.abs(cx - 0.1) < 0.55 && Math.abs(cy + 0.4) < 0.35;
      const inBottomArc = cy >  0.05 && Math.abs(cx + 0.1) < 0.55 && Math.abs(cy - 0.4) < 0.35;
      const inMiddle    = Math.abs(cy) < 0.15 && Math.abs(cx) < 0.5;
      const topHole     = cy < -0.05 && Math.abs(cx - 0.1) < 0.3  && Math.abs(cy + 0.4) < 0.15;
      const bottomHole  = cy >  0.05 && Math.abs(cx + 0.1) < 0.3  && Math.abs(cy - 0.4) < 0.15;
      if ((inTopArc || inBottomArc || inMiddle) && !topHole && !bottomHole) {
        r = 255; g = 255; b = 255;
      }
      row[px] = r; row[px+1] = g; row[px+2] = b;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // 8-bit RGB

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

[16, 48, 128].forEach(size => {
  fs.writeFileSync(`icons/icon${size}.png`, makePNG(size));
  console.log(`✅ icons/icon${size}.png`);
});
console.log('Done!');
