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

function hexToRgb(hex) {
  let value = String(hex || "").replace("#", "").trim();
  if (value.length === 3 || value.length === 4) {
    value = value.slice(0, 3).split("").map((part) => part + part).join("");
  } else {
    value = value.slice(0, 6);
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) {
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

  const colors = image.mimeType === "image/svg+xml" || /<svg/i.test(bytes.toString("utf8", 0, 200))
    ? colorsFromSvg(bytes)
    : colorsFromPng(bytes);
  const rgb = pickDominantRgb(colors);
  if (!rgb) {
    return null;
  }
  return paletteFromRgb(rgb.r, rgb.g, rgb.b);
}
