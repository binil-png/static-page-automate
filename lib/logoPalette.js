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
    if (usableColor(rgb.r, rgb.g, rgb.b)) {
      found.push(rgb);
    }
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
      if (usableColor(row[index], row[index + 1], row[index + 2], alpha)) {
        found.push({ r: row[index], g: row[index + 1], b: row[index + 2] });
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
      if (bits === 0) {
        if (offset >= bytes.length) {
          return -1;
        }
        let value = bytes[offset++];
        if (value === 0xFF) {
          const stuffed = bytes[offset++];
          if (stuffed !== 0x00) {
            return -1;
          }
        }
        buffer = value;
        bits = 8;
      }
      bits -= 1;
      return (buffer >> bits) & 1;
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

function colorsFromJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return [];
  }

  let offset = 2;
  const quant = [];
  const dcTables = [];
  const acTables = [];
  let components = [];
  let scanStart = -1;
  let scanComponents = [];

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xFF) {
      offset += 1;
    }
    const marker = bytes[offset++];
    if (marker === 0xD9 || marker === 0xDA) {
      if (marker === 0xDA) {
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        const count = bytes[offset + 2];
        scanComponents = [];
        let cursor = offset + 3;
        for (let index = 0; index < count; index += 1) {
          scanComponents.push({
            id: bytes[cursor],
            dc: bytes[cursor + 1] >> 4,
            ac: bytes[cursor + 1] & 15
          });
          cursor += 2;
        }
        scanStart = offset + length;
      }
      break;
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const data = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xC0 || marker === 0xC1) {
      components = [];
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
    } else if (marker === 0xC4) {
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
  }

  if (scanStart < 0 || components.length < 1) {
    return [];
  }

  const reader = jpegBitReader(bytes, scanStart);
  const prevDc = components.map(() => 0);
  const maxH = Math.max(...components.map((item) => item.sampling >> 4)) || 1;
  const maxV = Math.max(...components.map((item) => item.sampling & 15)) || 1;
  const blocksPerMcu = components.map((item) => (
    Math.max(1, (item.sampling >> 4) * (item.sampling & 15))
  ));
  const found = [];
  const mcuLimit = 96;

  for (let mcu = 0; mcu < mcuLimit; mcu += 1) {
    const sample = {};
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      const scan = scanComponents.find((item) => item.id === component.id) || { dc: 0, ac: 0 };
      const dcTable = dcTables[scan.dc];
      const acTable = acTables[scan.ac];
      const qTable = quant[component.quant] || [];
      if (!dcTable || !acTable) {
        return found;
      }
      let yValue = 0;
      const blockCount = blocksPerMcu[index] || 1;
      for (let block = 0; block < blockCount; block += 1) {
        const category = readJpegHuffman(reader, dcTable);
        if (category < 0) {
          return found;
        }
        prevDc[index] += receiveJpegBits(reader, category);
        skipJpegAc(reader, acTable);
        yValue += prevDc[index] * (qTable[0] || 1);
      }
      sample[component.id] = yValue / blockCount / 8 + 128;
    }
    const yComp = components[0];
    const cbComp = components[1];
    const crComp = components[2];
    const rgb = ycbcrToRgb(
      sample[yComp.id] ?? 128,
      cbComp ? sample[cbComp.id] ?? 128 : 128,
      crComp ? sample[crComp.id] ?? 128 : 128
    );
    if (usableColor(rgb.r, rgb.g, rgb.b)) {
      found.push(rgb);
    }
    if (!maxH || !maxV) {
      break;
    }
  }
  return found;
}

function pickDominantRgb(colors) {
  if (!colors.length) {
    return null;
  }
  const buckets = new Map();
  for (const color of colors) {
    const key = `${color.r >> 4}-${color.g >> 4}-${color.b >> 4}`;
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += color.r;
    bucket.g += color.g;
    bucket.b += color.b;
    buckets.set(key, bucket);
  }
  const winner = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
  return {
    r: Math.round(winner.r / winner.count),
    g: Math.round(winner.g / winner.count),
    b: Math.round(winner.b / winner.count)
  };
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

export function paletteFromLogoImage(image) {
  if (!image || image.source === "generated" || image.role !== "logo" || !image.dataUri) {
    return null;
  }

  const bytes = imageBytes(image);
  if (!bytes?.length) {
    return null;
  }

  const head = bytes.toString("utf8", 0, Math.min(200, bytes.length));
  const colors = image.mimeType === "image/svg+xml" || /<svg/i.test(head)
    ? colorsFromSvg(bytes)
    : (bytes[0] === 0xFF && bytes[1] === 0xD8 ? colorsFromJpeg(bytes) : colorsFromPng(bytes));
  const rgb = pickDominantRgb(colors);
  if (!rgb) {
    return null;
  }
  return paletteFromRgb(rgb.r, rgb.g, rgb.b);
}
