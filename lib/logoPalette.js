import { inflateSync } from "node:zlib";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
  }
  const lightness = (max + min) / 2;
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  return {
    h: (hue * 60 + 360) % 360,
    s: saturation,
    l: lightness
  };
}

function hslToHex(h, s, l) {
  const sat = clamp(s, 0, 1);
  const light = clamp(l, 0, 1);
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hp < 1) {
    red = chroma;
    green = x;
  } else if (hp < 2) {
    red = x;
    green = chroma;
  } else if (hp < 3) {
    green = chroma;
    blue = x;
  } else if (hp < 4) {
    green = x;
    blue = chroma;
  } else if (hp < 5) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }
  const match = light - chroma / 2;
  const toHex = (value) => Math.round((value + match) * 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function hueToFamily(hue) {
  if (hue < 18 || hue >= 345) {
    return "rose";
  }
  if (hue < 45) {
    return "orange";
  }
  if (hue < 70) {
    return "amber";
  }
  if (hue < 100) {
    return "lime";
  }
  if (hue < 155) {
    return "emerald";
  }
  if (hue < 185) {
    return "teal";
  }
  if (hue < 205) {
    return "cyan";
  }
  if (hue < 230) {
    return "sky";
  }
  if (hue < 255) {
    return "blue";
  }
  if (hue < 290) {
    return "violet";
  }
  if (hue < 325) {
    return "fuchsia";
  }
  return "rose";
}

function usableColor(r, g, b, a = 255) {
  if (a < 140) {
    return false;
  }
  const { s, l } = rgbToHsl(r, g, b);
  return s >= 0.12 && l >= 0.1 && l <= 0.9;
}

export function normalizeHexColor(hex) {
  let value = String(hex || "").trim();
  if (!value) {
    return "";
  }
  if (!value.startsWith("#")) {
    value = `#${value}`;
  }
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "";
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex).slice(1);
  if (!value) {
    return null;
  }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function imageBytes(image) {
  const uri = String(image?.dataUri || "");
  const comma = uri.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const header = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (/utf-?8/i.test(header)) {
    return Buffer.from(decodeURIComponent(body));
  }
  return Buffer.from(body, "base64");
}

function colorsFromSvg(bytes) {
  const text = bytes.toString("utf8");
  if (!/<svg/i.test(text)) {
    return [];
  }
  const found = [];
  for (const match of text.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const rgb = hexToRgb(match[1]);
    if (rgb && usableColor(rgb.r, rgb.g, rgb.b)) {
      found.push(rgb);
    }
  }
  for (const match of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
    const rgb = {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3])
    };
    found.push(rgb);
  }
  return found;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function reconstructPngRow(filter, row, prev, bpp) {
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bpp ? row[index - bpp] : 0;
    const up = prev[index];
    const upLeft = index >= bpp ? prev[index - bpp] : 0;
    if (filter === 1) {
      row[index] = (row[index] + left) & 255;
    } else if (filter === 2) {
      row[index] = (row[index] + up) & 255;
    } else if (filter === 3) {
      row[index] = (row[index] + Math.floor((left + up) / 2)) & 255;
    } else if (filter === 4) {
      row[index] = (row[index] + paeth(left, up, upLeft)) & 255;
    }
  }
}

function colorsFromPng(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return [];
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const chunks = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height || depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return [];
  }

  let raw;
  try {
    raw = inflateSync(Buffer.concat(chunks));
  } catch {
    return [];
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    return [];
  }

  const found = [];
  const stepX = Math.max(1, Math.floor(width / 72));
  const stepY = Math.max(1, Math.floor(height / 72));
  let cursor = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    const row = Buffer.from(raw.subarray(cursor + 1, cursor + 1 + stride));
    cursor += stride + 1;
    reconstructPngRow(filter, row, prev, channels);
    prev = row;
    if (y % stepY) {
      continue;
    }
    for (let x = 0; x < width; x += stepX) {
      const index = x * channels;
      const alpha = channels === 4 ? row[index + 3] : 255;
      if (alpha >= 140) {
        found.push({ r: row[index], g: row[index + 1], b: row[index + 2], a: alpha });
      }
    }
  }
  return found;
}

function jpegBitReader(bytes, start) {
  let offset = start;
  let buffer = 0;
  let bits = 0;
  return {
    bit() {
      while (bits === 0) {
        if (offset >= bytes.length) {
          return -1;
        }
        let value = bytes[offset++];
        if (value === 0xFF) {
          if (offset >= bytes.length) {
            return -1;
          }
          let stuffed = bytes[offset++];
          while (stuffed === 0xFF && offset < bytes.length) {
            stuffed = bytes[offset++];
          }
          if (stuffed !== 0x00) {
            if (stuffed >= 0xD0 && stuffed <= 0xD7) {
              buffer = 0;
              continue;
            }
            offset -= 2;
            while (offset > 0 && bytes[offset] !== 0xFF) {
              offset -= 1;
            }
            buffer = 0;
            return -1;
          }
        }
        buffer = value;
        bits = 8;
      }
      bits -= 1;
      return (buffer >> bits) & 1;
    },
    position() {
      return offset;
    }
  };
}

function buildJpegHuffman(lengths, symbols) {
  const lookup = Array.from({ length: 17 }, () => new Map());
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    code <<= 1;
    for (let count = 0; count < lengths[length]; count += 1) {
      lookup[length].set(code, symbols[index]);
      code += 1;
      index += 1;
    }
  }
  return lookup;
}

function readJpegHuffman(reader, lookup) {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    const bit = reader.bit();
    if (bit < 0) {
      return -1;
    }
    code = (code << 1) | bit;
    if (lookup[length].has(code)) {
      return lookup[length].get(code);
    }
  }
  return -1;
}

function receiveJpegBits(reader, count) {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const bit = reader.bit();
    if (bit < 0) {
      return 0;
    }
    value = (value << 1) | bit;
  }
  if (count && !(value & (1 << (count - 1)))) {
    value -= (1 << count) - 1;
  }
  return value;
}

function skipJpegAc(reader, acTable) {
  for (let index = 1; index < 64;) {
    const symbol = readJpegHuffman(reader, acTable);
    if (symbol < 0) {
      return;
    }
    if (symbol === 0) {
      return;
    }
    index += (symbol >> 4) + 1;
    receiveJpegBits(reader, symbol & 15);
  }
}

function ycbcrToRgb(y, cb, cr) {
  const red = y + 1.402 * (cr - 128);
  const green = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const blue = y + 1.772 * (cb - 128);
  return {
    r: clamp(Math.round(red), 0, 255),
    g: clamp(Math.round(green), 0, 255),
    b: clamp(Math.round(blue), 0, 255)
  };
}

function parseJpegDqt(data, quant) {
  let cursor = 0;
  while (cursor + 65 <= data.length) {
    const info = data[cursor];
    const table = [];
    cursor += 1;
    for (let index = 0; index < 64; index += 1) {
      table.push(info >> 4 ? data.readUInt16BE(cursor) : data[cursor]);
      cursor += info >> 4 ? 2 : 1;
    }
    quant[info & 15] = table;
  }
}

function parseJpegDht(data, dcTables, acTables) {
  let cursor = 0;
  while (cursor + 17 <= data.length) {
    const info = data[cursor];
    const lengths = [0];
    let total = 0;
    cursor += 1;
    for (let index = 0; index < 16; index += 1) {
      lengths.push(data[cursor]);
      total += data[cursor];
      cursor += 1;
    }
    const symbols = [...data.subarray(cursor, cursor + total)];
    cursor += total;
    const table = buildJpegHuffman(lengths, symbols);
    if (info >> 4) {
      acTables[info & 15] = table;
    } else {
      dcTables[info & 15] = table;
    }
  }
}

function skipJpegScan(bytes, offset) {
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    const next = bytes[offset + 1];
    if (next === 0x00 || next === 0xFF || (next >= 0xD0 && next <= 0xD7)) {
      offset += 1;
      continue;
    }
    return offset;
  }
  return bytes.length;
}

function jpegMcuCount(width, height, components) {
  const maxH = Math.max(1, ...components.map((item) => item.sampling >> 4));
  const maxV = Math.max(1, ...components.map((item) => item.sampling & 15));
  const cols = Math.ceil((width || 8) / (8 * maxH));
  const rows = Math.ceil((height || 8) / (8 * maxV));
  return Math.max(1, cols * rows);
}

function averageJpegSamples(samples, mode = "chroma") {
  if (!samples.length) {
    return null;
  }
  if (mode === "luma") {
    const dark = samples.filter((value) => value < 170);
    const pool = dark.length ? dark : samples;
    return pool.reduce((sum, value) => sum + value, 0) / pool.length;
  }
  const ranked = [...samples].sort((left, right) => Math.abs(right - 128) - Math.abs(left - 128));
  const pool = ranked.slice(0, Math.max(3, Math.ceil(ranked.length * 0.3)));
  return pool.reduce((sum, value) => sum + value, 0) / pool.length;
}

function colorsFromJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return [];
  }

  let offset = 2;
  const quant = [];
  const dcTables = [];
  const acTables = [];
  const prevDc = {};
  const samplesById = new Map();
  let components = [];
  let frameWidth = 0;
  let frameHeight = 0;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xFF) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      break;
    }
    const marker = bytes[offset++];
    if (marker === 0xD9) {
      break;
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    if (marker === 0xDA) {
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      const count = bytes[offset + 2];
      const scanComponents = [];
      let cursor = offset + 3;
      for (let index = 0; index < count; index += 1) {
        scanComponents.push({
          id: bytes[cursor],
          dc: bytes[cursor + 1] >> 4,
          ac: bytes[cursor + 1] & 15
        });
        cursor += 2;
      }
      const spectral = {
        start: bytes[cursor] || 0,
        end: bytes[cursor + 1] || 0,
        ah: (bytes[cursor + 2] || 0) >> 4,
        al: (bytes[cursor + 2] || 0) & 15
      };
      offset += length;
      const canReadDc = spectral.start === 0 && spectral.ah === 0 && components.length;
      if (!canReadDc) {
        offset = skipJpegScan(bytes, offset);
        continue;
      }
      const reader = jpegBitReader(bytes, offset);
      const mcuLimit = Math.min(12000, jpegMcuCount(frameWidth, frameHeight, components));
      for (let mcu = 0; mcu < mcuLimit; mcu += 1) {
        let hitEnd = false;
        for (const scan of scanComponents) {
          const component = components.find((item) => item.id === scan.id);
          if (!component) {
            continue;
          }
          const dcTable = dcTables[scan.dc];
          const acTable = acTables[scan.ac];
          const qTable = quant[component.quant] || [];
          if (!dcTable || (spectral.end > 0 && !acTable)) {
            hitEnd = true;
            break;
          }
          const blockCount = Math.max(1, (component.sampling >> 4) * (component.sampling & 15));
          let value = 0;
          for (let block = 0; block < blockCount; block += 1) {
            const category = readJpegHuffman(reader, dcTable);
            if (category < 0) {
              hitEnd = true;
              break;
            }
            prevDc[scan.id] = (prevDc[scan.id] || 0) + receiveJpegBits(reader, category);
            if (spectral.end > 0) {
              skipJpegAc(reader, acTable);
            }
            value += (prevDc[scan.id] << (spectral.al || 0)) * (qTable[0] || 1);
          }
          if (hitEnd) {
            break;
          }
          const sample = value / blockCount / 8 + 128;
          const list = samplesById.get(scan.id) || [];
          list.push(sample);
          samplesById.set(scan.id, list);
        }
        if (hitEnd) {
          break;
        }
      }
      offset = reader.position();
      if (samplesById.size >= components.length) {
        break;
      }
      continue;
    }
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) {
      break;
    }
    const data = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      components = [];
      frameHeight = data.readUInt16BE(1);
      frameWidth = data.readUInt16BE(3);
      let cursor = 6;
      const count = data[5];
      for (let index = 0; index < count; index += 1) {
        components.push({
          id: data[cursor],
          sampling: data[cursor + 1],
          quant: data[cursor + 2]
        });
        cursor += 3;
      }
    } else if (marker === 0xDB) {
      parseJpegDqt(data, quant);
    } else if (marker === 0xC4) {
      parseJpegDht(data, dcTables, acTables);
    }
  }

  if (!components.length || !samplesById.size) {
    return [];
  }

  const yComp = components[0];
  const cbComp = components[1];
  const crComp = components[2];
  const ySamples = samplesById.get(yComp.id) || [];
  const cbSamples = samplesById.get(cbComp?.id) || [];
  const crSamples = samplesById.get(crComp?.id) || [];
  const cbAvg = averageJpegSamples(cbSamples) ?? 128;
  const crAvg = averageJpegSamples(crSamples) ?? 128;
  const found = [];
  const count = ySamples.length;
  for (let index = 0; index < count; index += 1) {
    const yValue = ySamples[index];
    if (yValue > 175) {
      continue;
    }
    const cbIndex = cbSamples.length === count ? index : Math.min(cbSamples.length - 1, Math.floor(index * cbSamples.length / count));
    const crIndex = crSamples.length === count ? index : Math.min(crSamples.length - 1, Math.floor(index * crSamples.length / count));
    found.push(ycbcrToRgb(
      yValue,
      cbIndex >= 0 ? (cbSamples[cbIndex] ?? cbAvg) : cbAvg,
      crIndex >= 0 ? (crSamples[crIndex] ?? crAvg) : crAvg
    ));
  }
  if (!found.length) {
    const yAvg = averageJpegSamples(ySamples, "luma") ?? 128;
    found.push(ycbcrToRgb(yAvg, cbAvg, crAvg));
  }
  return found;
}

function pickDominantRgb(colors) {
  if (!colors.length) {
    return null;
  }
  const strict = colors.filter((color) => usableColor(color.r, color.g, color.b, color.a ?? 255));
  const loose = colors.filter((color) => {
    const { s, l } = rgbToHsl(color.r, color.g, color.b);
    return (color.a ?? 255) >= 140 && l >= 0.05 && l <= 0.94 && (s >= 0.05 || (l >= 0.12 && l <= 0.72));
  });
  const pool = strict.length ? strict : (loose.length ? loose : colors);
  const buckets = new Map();
  for (const color of pool) {
    const key = `${color.r >> 4}-${color.g >> 4}-${color.b >> 4}`;
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += color.r;
    bucket.g += color.g;
    bucket.b += color.b;
    buckets.set(key, bucket);
  }
  const winner = [...buckets.values()].map((bucket) => {
    const r = Math.round(bucket.r / bucket.count);
    const g = Math.round(bucket.g / bucket.count);
    const b = Math.round(bucket.b / bucket.count);
    const { s, l } = rgbToHsl(r, g, b);
    const score = bucket.count * (0.2 + s * 3) * (l >= 0.12 && l <= 0.82 ? 1.25 : 0.35);
    return { r, g, b, score };
  }).sort((left, right) => right.score - left.score)[0];
  return winner ? { r: winner.r, g: winner.g, b: winner.b } : null;
}

export function paletteFromHex(hex, overrides = {}) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const derived = paletteFromRgb(rgb.r, rgb.g, rgb.b);
  const deep = normalizeHexColor(overrides.deep || hex);
  const mid = normalizeHexColor(overrides.mid);
  return {
    ...derived,
    ...overrides,
    deep: deep || derived.deep,
    mid: mid || derived.mid
  };
}

export function paletteFromRgb(r, g, b) {
  const { h, s } = rgbToHsl(r, g, b);
  const sat = clamp(Math.max(0.38, s), 0, 0.72);
  return {
    id: "logo",
    family: hueToFamily(h),
    deep: hslToHex(h, sat, 0.38),
    mid: hslToHex(h, sat * 0.82, 0.62),
    bright: hslToHex(h, sat, 0.5),
    pale: hslToHex(h, sat * 0.32, 0.93),
    wash: hslToHex(h, sat * 0.16, 0.98),
    ink: hslToHex(h, sat * 0.72, 0.28),
    onDeep: "#ffffff",
    onMid: hslToHex(h, sat * 0.8, 0.22),
    quote: hslToHex(h, sat * 0.5, 0.72)
  };
}

function colorsFromBmpDib(dib) {
  if (!dib || dib.length < 40) {
    return [];
  }
  const headerSize = dib.readUInt32LE(0);
  const width = Math.abs(dib.readInt32LE(4));
  const rawHeight = dib.readInt32LE(8);
  const height = Math.abs(rawHeight);
  const xorHeight = rawHeight < 0 ? height : Math.max(1, Math.floor(height / 2) || height);
  const bitCount = dib.readUInt16LE(14);
  if (!width || !xorHeight || (bitCount !== 24 && bitCount !== 32) || headerSize < 40) {
    return [];
  }
  const bytesPerPixel = bitCount / 8;
  const rowSize = Math.ceil((width * bitCount) / 32) * 4;
  const colors = [];
  const stepX = Math.max(1, Math.floor(width / 16));
  const stepY = Math.max(1, Math.floor(xorHeight / 16));
  for (let y = 0; y < xorHeight; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const index = headerSize + y * rowSize + x * bytesPerPixel;
      if (index + bytesPerPixel > dib.length) {
        continue;
      }
      if (bitCount === 32 && dib[index + 3] < 32) {
        continue;
      }
      colors.push({ r: dib[index + 2], g: dib[index + 1], b: dib[index] });
    }
  }
  return colors;
}

function colorsFromIco(bytes) {
  const pngStart = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  if (pngStart >= 0) {
    return colorsFromPng(bytes.subarray(pngStart));
  }
  if (bytes.length < 22 || bytes.readUInt16LE(2) !== 1) {
    return [];
  }
  const count = bytes.readUInt16LE(4);
  let bestOffset = 0;
  let bestSize = 0;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) {
      break;
    }
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (size > bestSize && offset > 0 && offset + 40 <= bytes.length) {
      bestSize = size;
      bestOffset = offset;
    }
  }
  return bestOffset ? colorsFromBmpDib(bytes.subarray(bestOffset)) : [];
}

export function paletteFromLogoImage(image) {
  if (!image || image.source === "generated" || image.source === "ai" || !image.dataUri) {
    return null;
  }
  const name = `${image.originalName || ""} ${image.fileName || ""}`;
  if (image.role && image.role !== "logo" && !/logo|icon|favicon|\.ico$/i.test(name)) {
    return null;
  }

  const bytes = imageBytes(image);
  if (!bytes?.length) {
    return null;
  }

  const head = bytes.toString("utf8", 0, Math.min(200, bytes.length));
  const isIco = bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;
  const colors = image.mimeType === "image/svg+xml" || /<svg/i.test(head)
    ? colorsFromSvg(bytes)
    : (bytes[0] === 0xFF && bytes[1] === 0xD8
      ? colorsFromJpeg(bytes)
      : (isIco ? colorsFromIco(bytes) : colorsFromPng(bytes)));
  const rgb = pickDominantRgb(colors);
  if (!rgb) {
    console.warn(`Could not sample colors from ${image.originalName || image.fileName || "brand image"} (${image.mimeType || "unknown type"}).`);
    return null;
  }
  return paletteFromRgb(rgb.r, rgb.g, rgb.b);
}
